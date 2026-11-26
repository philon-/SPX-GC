
// -------------------------------------------------------
// Handle Express server routes for the CasparCG commands.
// -------------------------------------------------------
var express = require("express");
const router = express.Router();
const path = require('path');

const logger = require('../utils/logger');
logger.debug('Caspar-route loading...');
const spx = require('../utils/spx_server_functions.js');

const net = require('net');
const { openFolderInOS } = require('../utils/spx_paths.js');


// ROUTES CCG -----------------------------------------------------------------------------------
router.get('/', function (req, res) {
  res.send('Nothing here. Go away!');
});

router.get('/system', function (req, res) {
  res.send('Nothing here. Get lost.');
});

router.get('/requestInfo', (req, res) => {
  // Sends one AMCP command (?server=OVERLAY&command=INFO) on a separate
  // connection and answers with CasparCG's reply as text.
  const server = global.CCGSockets.find((s) => String(s.spxname).toLowerCase() === String(req.query.server || '').toLowerCase());
  if (!server) {
    return res.status(404).send('CasparCG server [' + req.query.server + '] is not configured.');
  }
  // One command per request: no line breaks.
  const command = String(req.query.command || '').replace(/[\r\n]/g, ' ').trim();
  if (!command) {
    return res.status(400).send('command is required.');
  }

  const request = new net.Socket();
  let answered = false;
  const answer = (status, body) => {
    if (answered) return;
    answered = true;
    request.destroy();
    res.status(status).type('text/plain').send(body);
  };
  request.setTimeout(5000, () => answer(504, 'No reply from CasparCG [' + server.spxname + '].'));
  request.on('error', (error) => answer(502, 'CasparCG [' + server.spxname + '] error: ' + error.message));
  request.on('data', (data) => answer(200, data));
  request.connect(server.spxport, server.spxhost, () => request.write(command + '\r\n'));
});

router.get('/system/:data', (req, res) => {
  // OS level utilities requested by the controller UI (open folders,
  // connection check, restart).
  let data;
  try {
    data = JSON.parse(req.params.data);
  } catch (error) {
    return res.status(400).send('Invalid JSON in /CCG/system request.');
  }
  logger.verbose('System utilities / ' + JSON.stringify(data));
  res.sendStatus(200);
  switch (data.command) {

    case 'DATAFOLDER':
    case 'TEMPLATEFOLDER':
      if (config.general.disableOpenFolderCommand == true) {
        logger.warn('Open folder commands are disabled in config.');
        break;
      }
      openFolderInOS(data.command == 'DATAFOLDER'
        ? path.normalize(config.general.dataroot)
        : path.join(spx.getStartUpFolder(), 'ASSETS', 'templates'));
      break;

    case 'CHECKCONNECTIONS':
      spx.checkServerConnections();
      break;

    case 'RESTARTSERVER':
      logger.error('RESTART SERVER REQUEST RECEIVED. Will try to kill and restart using process manager.');
      process.exit(2);
      break;

  }
});

router.post('/disable', async (req, res) => {
  // Added in 1.1.0. Set "disabled" state of the given CasparCG server
  // This only affects playback commands. Initialization works normally.
  logger.verbose('CasparCG server ' + req.body.server + ' disabled to ' + req.body.disabled);
  try {
    var ConfigFile = global.configfileref;
    var ConfigData = await spx.GetJsonData(ConfigFile);
    if (ConfigData.casparcg.servers) {
      ConfigData.casparcg.servers.forEach((serverItem,index) => {
        if (serverItem.name == req.body.server) {
          serverItem.disabled = req.body.disabled
        }
      });
    }
    global.config = ConfigData; // update mem version also
    await spx.writeFile(ConfigFile,ConfigData);
    let response = ['Config changed']
    res.status(200).send(response); // ok 200 AJAX RESPONSE
  } catch (error) {
      console.error('ERROR', error);
      let errmsg = 'Server error in CCG disable [' + error + ']';
      logger.error(errmsg);
      res.status(500).send(errmsg)  // error 500 AJAX RESPONSE
  };
});


// Create all required Socket Connections for CasparCG servers specified in config.json
// Each connection reconnects by itself (with backoff) when it is closed, so a
// CasparCG restart mid-show does not need an SPX restart.
let ServerDataForLogger = [];
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// "202 PLAY OK" -> { code: '202', text: '202 PLAY OK' }; data lines -> null
function parseAmcpLine(line) {
  const match = /^(\d{3})\b/.exec(line);
  return match ? { code: match[1], text: line } : null;
}

if (config.casparcg) {
  config.casparcg.servers.forEach((element,index) => {
    const CurName = element.name;
    const CurHost = element.host;
    const CurPort = element.port;

    ServerDataForLogger.push({ name: CurName, host: CurHost, port: CurPort });

    var CurCCG = new net.Socket();
    global.CCGSockets.push(CurCCG); // --> PUSH Socket object to a global array for later use
    CurCCG.spxname = CurName; // save each entry a name for later searching!
    CurCCG.spxhost = CurHost; // save each entry a host for later searching! (v.1.0.14)
    CurCCG.spxport = CurPort; // save each entry a port for later searching! (v.1.0.14)

    let reconnectDelay = RECONNECT_MIN_MS;
    let reconnectTimer = null;
    let lineBuffer = '';
    const indicator = (color) => io.emit('SPXMessage2Client', { spxcmd: 'updateServerIndicator', indicator: 'indicator' + index, color: color });
    const status = (text) => io.emit('SPXMessage2Client', { spxcmd: 'updateStatusText', status: text });

    const connect = () => {
      reconnectTimer = null;
      lineBuffer = '';
      CurCCG.connect(CurPort, CurHost);
    };

    CurCCG.on('connect', function () {
      reconnectDelay = RECONNECT_MIN_MS;
      indicator('#00CC00');
      status('Communication established with ' + CurName + '.');
      logger.verbose('SPX connected to CasparCG as \'' + CurName + '\' at ' + CurHost + ":" + CurPort + '.');
    });

    CurCCG.on('data', function (chunk) {
      logger.verbose('SPX received data from CasparCG ' + CurName + ': ' + chunk);
      // AMCP replies are lines; a chunk can hold several replies or part of one.
      lineBuffer += String(chunk);
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop();
      for (const line of lines) {
        const reply = parseAmcpLine(line.trim());
        if (!reply) continue; // data line of a multi-line reply
        switch (reply.code.charAt(0)) {
          case '1':
          case '2':
            logger.verbose('Comms good with ' + CurName + ": " + reply.text);
            break;
          case '4':
            logger.error(CurName + ' CasparCG response: ' + reply.text );
            logger.debug('Verify CasparCG\'s (' + CurName + ') access to templates on SPX server at ' + spx.getTemplateSourcePath());
            status('Error in comms with ' + CurName + '.');
            break;
          case '5':
            logger.error('Failed ' + CurName + ": " + reply.text);
            status(CurName + ' failed.');
            break;
          default:
            logger.error('Unknown status value ' + CurName + ' - ' + reply.text);
        }
      }
      indicator('#00CC00');
    });

    CurCCG.on('close', function () {
      indicator('#CC0000');
      status('Connection to ' + CurName + ' was closed.');
      if (reconnectTimer) return;
      logger.verbose('SPX connection to CasparCG "' + CurName + '" closed (' + CurHost + ':' + CurPort + '). Reconnecting in ' + reconnectDelay + ' ms.');
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectTimer.unref();
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    });

    CurCCG.on('error', function (err) {
      // 'close' follows and schedules the reconnect.
      indicator('#CC0000');
      status('Communication error with ' + CurName + '.');
      logger.warn('Unable to connect CasparCG "' + CurName + '" (' + CurCCG.spxhost + ':'  + CurCCG.spxport + '). Is it running? ' + err.message);
    });

    connect();
  });
}; // end if 

logger.debug('ServerDataForLogger during init: ' + JSON.stringify(ServerDataForLogger));
module.exports = router;