var configName = process.argv[2];
if (!configName) {
  console.log('Usage:', process.argv[0], process.argv[1], '[env]');
  process.exit(-1);
}

var path = require('path');
var express = require('express');
var cors = require('cors');
var jsonParser = require('body-parser').json;
var glob = require('glob');
var onResponse = require('on-response');

var createGoesClient = require('goes-client').client;
var createGoesReader = require('goes-client').reader;
var commandHandlerFactory = require('./services/commandHandler');
var ReadRepository = require('./services/ReadRepository');

import {newInject} from './utils';
import Logger from './services/logger';

function wireUp(config) {
  const app = express();
  app.use(cors());
  app.use(jsonParser());

  const goesClient = createGoesClient(config.goesUrl, Logger);
  registerEventTypes(goesClient);
  const commandHandler = commandHandlerFactory(goesClient, Logger);
  const goesReader = createGoesReader(config.goesStoragePath);
  const readRepository = new ReadRepository(goesReader, Logger);
  registerModels(readRepository);

  app.use(function (req, res, next) {
    var start = Date.now();
    onResponse(req, res, function (err, summary) {
      Logger.access(
        summary.request.remoteAddress,
        '-',
        req.user ? req.user.username : '-',
        '-',
        '"' + [summary.request.method, summary.request.url, 'HTTP/' + summary.request.httpVersion].join(' ') + '"',
        '"' + summary.request.userAgent + '"',
        '-',
        res.statusCode,
        summary.response.length || 0,
        Date.now() - start);
    });
    next();
  });

  app.use('/', express.static(path.join(__dirname, '..', 'web')));

  const services = {
    app: app,
    goesClient: goesClient,
    goesReader: goesReader,
    readRepository: readRepository,
    commandHandler: commandHandler,
    logger: Logger
  };
  registerControllers(services);

  app.use(function (err, req, res, next) {
    Logger.error(err.stack);
    res.status(500).send({message: err.message, code: err.code || 'unknown'});
  });

  function listening() {
    Logger.info('App ready and listening on port', config.httpPort);
  }

  if (config.useHttps) {
    var https = require('https');
    var fs = require('fs');
    var key = fs.readFileSync(config.keyFile);
    var cert = fs.readFileSync(config.certFile);
    https.createServer({
      key: key,
      cert: cert
    }, app).listen(config.httpPort, listening);
  } else {
    app.listen(config.httpPort, listening);
  }
}

function registerEventTypes(goesClient) {
  goesClient.registerTypes.apply(goesClient,
      glob.sync(path.join(__dirname, 'events', '*.js'))
          .map(f => {
            var module = require(f);
            if (typeof module === 'object') {
              return module.default;
            }
            return module;
          }));
}

function registerModels(readRepository) {
  glob.sync(path.join(__dirname, 'readModels', '*.js'))
      .forEach(filePath => {
        var model = require(filePath);
        var name = path.basename(filePath, '.js');
        readRepository.define(name, model);
      });
}

function registerControllers(services) {
  glob.sync(path.join(__dirname, 'controllers', '**/*.js'))
      .forEach(filePath => {
        var module = require(filePath);
        var T = module.default ? module.default : module;
        services.logger.info('Registering controller:', T.name);
        newInject(T, services);
      });
}

var config = require('../config/' + configName + '.json');
wireUp(config);