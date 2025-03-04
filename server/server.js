/**
 * Copyright 2019 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const app = require('express')()
const path = require('path')
const logger = require('./logger')
const http = require('http').Server(app);
const io = require('socket.io')(http);
const JobQueue = require('./jobQueue')
const uuid = require('./uuid');
const fs = require('fs')
const security = require('./security')
const ui = require('./ui')
const admin = require('./admin')
const config = require('./config')
const functions = require("./functions");
const utils = require("./utils");
const controllers = require("./websockets/controllers");
const {performance, setupPerformance} = require('./performance')
const timeout = require('connect-timeout');
const bodyParser = require("body-parser");

const SERVER_TIMEOUT = 1000 * 60 * 15

app.use(timeout(SERVER_TIMEOUT));
app.use(haltOnTimedout);
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

setupPerformance()
ui.setupUi(app)

function haltOnTimedout(req, res, next){
    if (!req.timedout) {
        next();
    }
}

const jobQueue = new JobQueue()

admin.setupAdmin(app)

app.get('/controller', (req, res) => {
    const urlApplicationId = utils.getApplicationIdAsSubDomain(req)
    const accessKey = security.getAuthenticationToken(req)

    if (!accessKey) {
        res.status(401)
        res.send('Access key is required')
        return
    }

    if (urlApplicationId && req.hostname !== 'localhost') {
        const appId = functions.getApplicationIdFromAuthToken(accessKey)

        if (appId === urlApplicationId.toLowerCase()) {
            if (functions.applicationAllowsCustomControllers(appId)) {
                res.sendFile(__dirname + '/controller.html')
            } else {
                res.status(401)
                res.send('Application is not set to allow custom controllers')
            }
        } else {
            res.status(401)
            res.send('Access key is invalid')
        }
    } else {
        if (accessKey === config.masterAccessKey) {
            res.sendFile(__dirname + '/controller.html')
        } else {
            res.status(401)
            res.send('Access key is invalid')
        }
    }
})

// Specifically handle templates requesting the js files from templates folder
// so that it works via function execute, as well as locally loading it
app.get('/templates/:fileName.js', (req, res, next) => {
    let filePath = `${__dirname}/../templates/${req.params.fileName}.js`
    const functionData = fs.readFileSync(filePath)
    res.type("js")
    res.send(functionData);
})

// Serve resources required by template files
app.get('/templates/resources/:fileName', (req, res, next) => {
    let filePath = `${__dirname}/../templates/resources/${req.params.fileName}`
    const functionData = fs.readFileSync(filePath);
    if (req.params.fileName.endsWith(".wasm")) {
        res.type('application/wasm')
    }
    res.send(functionData);
})

app.all('/static/*', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
        next()
        return
    }
    const params = path.parse(req.params[0])
    const fileName = params.name;
    const fileType = params.ext.replace('.', '')
    let folder = ''
    if (params.dir && params.dir !== '/') {
        folder = params.dir + '/'
    }

    const requestHost = req.headers.host.split(':')[0]
    const applicationId = utils.getApplicationIdAsSubDomain(req)

    if (requestHost !== `${applicationId}.${config.functionDomain}`) {
        logger.warn('Attempting to access files outside of app domain')
        res.status(401)
        next()
        return
    }

    if (fileName === 'environment' && params.ext === '.json') {
        logger.warn('Read access to environment.json denied')
        res.status(401)
        next()
        return
    }

    let filePath = `${config.functionsRoot}${applicationId}/files/${folder}${fileName}${params.ext}`

    // todo: allow this to be configurable per app
    res.set('Access-Control-Allow-Origin', '*')

    const functionData = fs.readFileSync(filePath)
    const templateFile = `${__dirname}/../templates/${fileType}.html`
    if (req.query['invoke'] && fs.existsSync(templateFile)) {
        // wrap the file in the appropriate template
        const functionTemplate = fs.readFileSync(templateFile).toString()
        let output = functionTemplate.replace(/{{EMBEDDED_CODE}}/g, functionData)
        output = output.replace(/{{URL}}/g, `/static/${folder}${fileName}${params.ext}`)
        res.type('html')
        res.send(output);
    } else {
        // skip template handling
        res.type(fileType)
        if (fileType === 'wasm') {
            res.type('application/wasm')
        }
        res.send(functionData);
    }
})

const measureResponseTime = () => {
    performance.mark('RESPONSE_SENT');
    performance.measure("Total Execution Time", 'REQUEST_RECEIVED', 'RESPONSE_SENT')
}

function onJobSuccess(data, res) {
    try {
        res.status(200)
    } catch (err) {
        // headers probably already sent...
    }

    try {
        if (!data) {
            // send nothing back
        } else if (typeof data === 'object') {
            if (data.headers && data.status) { // duck typing to determine if the user is trying to return a response object
                if (data.status) {
                    res.status(data.status)
                }

                if (data.headers.length) {
                    data.headers.forEach((i) => {
                        res.set(i)
                    })
                } else {
                    res.set(data.headers)
                }

                if (data.body) {
                    if (typeof data.body === 'object') {
                        res.write(JSON.stringify(data.body))
                    } else {
                        res.write(data.body.toString())
                    }
                }
            } else {
                res.write(JSON.stringify(data))
            }
        } else {
            res.write(data.toString())
        }
        res.flushHeaders()
    } catch (err) {
        logger.error(err)
        res.write("Internal Server Error: ")
        res.write(err.message)
        res.end()
    }
}

function executeJobAndSendResponse(applicationId, functionPath, args, metadata, res) {
    const jobId = uuid.v4()

    jobQueue.push({
        jobId: jobId,
        applicationId: applicationId,
        functionName: functionPath,
        onSuccess:  function (data) {
            onJobSuccess(data, res)
            measureResponseTime()
        },
        onComplete: function (data) {
            res.end()
            measureResponseTime()
        },
        onFailure: function (err) {
            try {
                res.status(500)
            } catch (err) {
                // headers probably already sent...
            }

            res.write(err)
            res.end()
            measureResponseTime()
        },
    })

    const functionUrl = `${config.protocol}://${applicationId}.${config.functionDomain}${config.portInfo}/static/${functionPath}`

    const functionData = functions.getApplicationMetaData(applicationId)
    const executeController = controllers.getNextExecutionController(applicationId, functionData.settings)
    executeController.emit("EXECUTE", {
        url: functionUrl, path: functionPath,
        args: args, metadata: metadata, jobId: jobId
    })
}

function getEnvironment(req, funcData) {
    let env = req.headers['execution-environment'] || "production"
    try {
        return funcData['settings']['environment'][env]
    } catch (err) {
        return {
            "error": "Cannot read environment " + env,
            "details": err
        }
    }
}

app.all('/execute/*', (req, res) => {
    performance.mark('REQUEST_RECEIVED');

    const params = path.parse(req.params[0])
    const fileName = params.base;
    let folder = ''
    if (params.dir && params.dir !== '/') {
        folder = params.dir + '/'
    }

    const applicationId = utils.getApplicationIdAsSubDomain(req)
    if (!functions.checkApplicationExists(applicationId)) {
        throw new Error('Application does not exist')
    }

    const functionData = functions.getApplicationMetaData(applicationId)

    if (controllers.availableControllers(applicationId, functionData.settings) === 0) {
        res.status(500)
        res.send("No controllers connected")
        return
    }

    const functionName = `${folder}${fileName}`
    let data = req.method === 'GET' ? req.query : req.body

    // pass some metadata to our function
    let metadata = {
        'request': {
            'headers': req.headers,
            'method': req.method
        },
        'env': getEnvironment(req, functionData)
    }

    // todo: allow this to be configurable per app
    res.set('Access-Control-Allow-Origin', '*')

    // not yet supporting calling functions that are in nested folders
    if (functions.checkFunctionExists(applicationId, functionName)) {
        executeJobAndSendResponse(applicationId, functionName, data, metadata, res)
    } else {
        res.status(404)
        res.send('Function not found')
    }
})

io.of('/controller').on('connection', function (socket) {
    socket.on('disconnect', (reason) => {

        controllers.removeController(socket)
        logger.info(`websocket disconnected: ${reason}`);
    });

    socket.on("JOB_COMPLETED", (data) => {
        jobQueue.completeJob({jobId: data.jobId, data: data.response})
    })

    socket.on("JOB_STREAM", (data) => {
        jobQueue.streamJob({jobId: data.jobId, data: data.response})
    })

    socket.on("CONSOLE", (data) => {
        const jobData = jobQueue.getJob(data.jobId)
        if (jobData && jobData.applicationId) {
            functions.saveJobLogs(jobData.applicationId, {jobId: data.jobId, type: data.type, functionName: jobData.functionName, message: data.message})
        }
    })

    socket.on("JOB_FAILED", (data) => {
        jobQueue.failJob({jobId: data.jobId, data: data.response})
    })

    socket.on("IDENTITY", (data) => {
        socket.browser = data.name
        socket.browserVersion = data.version
        socket.connectedAt = new Date()
        socket.id = uuid.v4()
        socket.accessKey =  data.accessKey

        logger.info(`Controller connected: ${socket.browser} ${socket.browserVersion}`)

        if (socket.accessKey === config.masterAccessKey) {
            controllers.addMasterController(socket)

        } else {
            const appId = functions.getApplicationIdFromAuthToken(socket.accessKey)

            if (appId && functions.applicationAllowsCustomControllers(appId)) {
                controllers.addApplicationController(appId, socket)
            } else {
                socket.disconnect()
            }
        }
    })
});

const server = http.listen(config.port, '0.0.0.0', () => logger.info(`Running on port ${config.port}!`))
server.setTimeout(SERVER_TIMEOUT + 1000);
