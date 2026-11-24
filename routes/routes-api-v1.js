
/*  ------------------------------------------ 

  Public API routes for external controllers
  such as Stream Deck or similar.

  /api/v1/

  Home route is a list of available commands.

--------------------------------------------- */

var express = require("express");
const router = express.Router();
const path = require('path');
const fs = require('fs');
const moment = require('moment');
const directoryPath = path.normalize(config.general.dataroot);
const logger = require('../utils/logger');
logger.debug('API-v1 route loading...');
const spx = require('../utils/spx_server_functions.js');
const xlsx = require('node-xlsx').default;
const axios = require('axios')
const PlayoutCCG = require('../utils/playout_casparCG.js');
const { query } = require("../utils/logger");
const spxAuth = require('../utils/spx_auth.js');
let apiCache = [] // used to cache [undocumented] API calls
let ack = 'Sent request to SPX server. Acknowledgement is not to be expected.'
let ack2 = 'Sent request to SPX Controller. Acknowledgement is not to be expected.'
const apiHandler = require('../utils/api-handlers.js');
const autoOut = require('../utils/spx_autoout.js');

const notInSolo = {
	status: 501,
	message: 'Not Implemented',
	info: 'This API endpoint is not available in SPX Solo.',
  more: 'For advanced API features, please see SPX Production or Broadcast: https://spxgraphics.com/software#compare'
}

// ROUTES -------------------------------------------------------------------------------------------
router.get('/', function (req, res) {
	let functionsDoc = {
		"sections": [

			{
				"section": "Common API",
				"info": "Generic API endpoints and utilities available in all SPX versions without a license.",
				"commands": [
					{
						"vers": "v1.1.2",
						"method": "GET",
						"param": "/api/v1/version",
						"info": "Returns SPX version info and current host-id"
					},
					{
						"vers": "v1.1.0",
						"method": "GET",
						"param": "/api/v1/panic",
						"info": "Force clear to all output layers without out-animations. (Note, this does NOT save on-air state of rundown items to false, so when UI is reloaded the items will show the state before panic was triggered.) This is to be used for emergency situations only and not as a normal STOP command substitute."
					},
					{
						"vers": "v1.0.14",
						"method": "GET",
						"param": "/api/v1/feedproxy?url=https://feeds.bbci.co.uk/news/rss.xml&format=xml",
						"info": "A proxy endpoint for passing feed data from CORS protected datasources. (If you need to pass url parameters use <code>%26</code> instead of <code>&</code> to separate them)."
					},
					{
						"vers": "v1.3.0",
						"method": "POST",
						"param": "/api/v1/feedproxy",
						"info": "A POST version of the feedproxy endpoint. This endpoint is a helper for outgoing GET or POST requests requiring custom headers, such as <code>Authorization</code> or similar. Data is passed to the helper in the <code>body</code> of the POST request, in which <code>url</code> is the actual URL of the external endpoint. If the body contains a <code>postBody</code> -object, it will be passed to the outgoing API request as <code>body</code>. See principle in the example below, or search SPX Knowledge Base for more info with keyword <code>feedproxy</code>.",
						"code": { url: "https://api.endpoint.com/requiring/customheaders/", headers: { "key1": "my first value", "key2": "second value" }, postBody: { info: "If postBody is found, the outgoing request will be done using POST method, otherwise as GET." } }
					},
				]
			},

			{
				"section": "Controller API",
				"restriction": "Some endpoints require SPX Production license",
				"info": "API endpoints for controlling the SPX Graphics Controller rundown. Please note some endpoints will require a valid SPX Production license.",
				"commands": [
					{
						"vers": "1.0",
						"method": "GET",
						"param": "/api/v1/rundown/focusPrevious",
						"info": "Move focus up to previous item, will not circle back to bottom when top is reached."
					},
					{
						"vers": "1.0",
						"method": "GET",
						"param": "/api/v1/rundown/focusNext",
						"info": "Move focus down to next item, will not circle back to top when end is reached."
					},
					{
						"vers": "1.0",
						"method": "GET",
						"param": "/api/v1/rundown/stopAllLayers",
						"info": "Animate all layers (used by the current rundown) out, but does not clear layers."
					},
					{
						"vers": "1.0",
						"method": "GET",
						"param": "/api/v1/item/play",
						"info": "Start focused item."
					},
					{
						"vers": "1.0",
						"method": "GET",
						"param": "/api/v1/item/continue",
						"info": "Issue continue command to selected item. Notice this needs support from the template itself and does not work as play or stop."
					},
					{
						"vers": "1.0",
						"method": "GET",
						"param": "/api/v1/item/stop",
						"info": "Stop focused item."
					},
					{
						"vers": "1.0",
						"method": "GET",
						"param": "/api/v1/rundown/load?file=MyFirstProject/MyFirstRundown",
						"info": "Open rundown from project / file."
					},
					{
						"vers": "1.0",
						"method": "GET",
						"param": "/api/v1/rundown/focusFirst",
						"info": "Move focus to the first item on the rundown.",
					},
					{
						"vers": "1.0",
						"method": "GET",
						"param": "/api/v1/rundown/focusLast",
						"info": "Move focus to the last item on the rundown.",
					},
					{
						"vers": "1.0",
						"method": "GET",
						"param": "/api/v1/rundown/focusByID/1234567890",
						"info": "Move focus by ID on the rundown.",
					},

					{
						"vers": "1.0",
						"method": "GET",
						"param": "/api/v1/item/play/1234567890",
						"info": "Start item by ID on the active rundown. The command is passed to the open controller, so the response is <code>200</code> even if no controller is open or the ID is not found. To play an item of a given rundown file, use <code>controlRundownItemByID</code>.",
					},

					{
						"vers": "1.0",
						"method": "GET",
						"param": "/api/v1/item/continue/1234567890",
						"info": "Continue to item by ID on the active rundown. Notice this needs support from the template itself and does not work as play or stop. Like play by ID, this is passed to the open controller and always returns <code>200</code>.",
					},

					{
						"vers": "1.0",
						"method": "GET",
						"param": "/api/v1/item/stop/1234567890",
						"info": "Stop item by ID on the active rundown. Like play by ID, this is passed to the open controller and always returns <code>200</code>.",
					},
					{
						"vers": "v1.0.12",
						"method": "GET",
						"param": "/api/v1/invokeTemplateFunction?playserver=OVERLAY&playchannel=1&playlayer=19&webplayout=19&function=myCustomTemplateFunction&params=Hello%20World",
						"info": "Uses an invoke handler to call a function in a template that is on air. <code>function</code> is required and must be a plain JavaScript function name (letters, digits, <code>_</code> and <code>$</code>). <code>params</code> is optional and is passed to the function as a string; JSON objects can be passed by urlEncoding stringified JSON. Targets: <code>webplayout</code> is a web renderer layer (layers above 5 use layer 5), and <code>playserver</code>, <code>playchannel</code> and <code>playlayer</code> address CasparCG (channel and layer default to 1). Give at least one target; use <code>-</code> or leave a target out to skip it. A CasparCG server that is not configured or is disabled in SPX is skipped, and the response lists that in <code>warnings</code>. Returns <code>400</code> for invalid parameters. Search SPX Knowledge Base for more info with keyword <code>invoke</code>.",
					},
					{
						"vers": "v1.3.0",
						"method": "GET",
						"param": "/api/v1/invokeExtensionFunction?function=sendCmd&params=incrementNumber",
						"info": "Uses SPX's messaging system to call a function in an extension. JSON objects can be passed as params by urlEncoding stringified JSON. The extension will need to implement SPX's messaging system, search SPX Knowledge Base for more info with keyword <code>invokeExtensionFunction</code>.",
						"active": false,
					},

				]
			},

			{
				"section": "Server API",
				"restriction": "Some endpoints require SPX Broadcast license",
				"info": "API endpoints targeting the SPX server directly without going through the rundown controller. These endpoints are for advanced uses and some of them require a SPX Broadcast license.",
				"commands": [
					{
						"vers": "v1.0.12, v.1.3.2",
						"method": "POST",
						"param": "/api/v1/directplayout",
						"info": "Populate a template and execute a <code>play</code>, <code>continue</code> or <code>stop</code> command to it, without a rundown item. <code>relativeTemplatePath</code> is relative to <code>ASSETS/templates</code> and the file must exist there (otherwise <code>404</code>). Targets: <code>webplayoutLayer</code> is a web renderer layer (layers above 5 use layer 5), and <code>casparServer</code>, <code>casparChannel</code> and <code>casparLayer</code> address CasparCG. Give at least one target; use <code>-</code> or leave a target out to skip it. A CasparCG server that is not configured or is disabled in SPX is skipped, and the response lists that in <code>warnings</code>. <code>out</code> is <code>manual</code> (default) or a time in milliseconds, after which the server stops the template. <code>dataformat</code> is optional: <code>json</code> (default) or <code>xml</code>. Special characters in values are supported.<br><br>The optional <code>updateRundownItem</code> object links the playout to a rundown item and requires <code>itemID</code>, <code>project</code> and <code>rundown</code>. With <code>persist</code>, the values and on-air state are saved to that item (play and stop only, not continue). With <code>updateUI</code>, controllers showing that rundown are updated: they reload to show saved values, or, without <code>persist</code>, only the item's on-air indicator is updated. Returns <code>400</code> for an invalid body and <code>404</code> for an unknown template or rundown. Post request body example as JSON:",
						"code": { casparServer: "OVERLAY", casparChannel: "1", casparLayer: "20", webplayoutLayer: "20", relativeTemplatePath: "/vendor/pack/template.html", out: "manual", DataFields: [{ field: "f0", value: "Firstname" }, { field: "f1", value: "Lastname" }], command: "play", updateRundownItem: { updateUI: true, itemID: "myItemID", persist: true, "project": "myFirstProject", "rundown": "myFirstRundown" } }
					},
					{
						"vers": "v1.1.0",
						"method": "GET",
						"param": "/api/v1/controlRundownItemByID?file=MyProject/FirstRundown&item=1234567890&command=play",
						"info": "Play, continue or stop an item from a known rundown file. <code>file</code> is given as <code>Project/Rundown</code>, <code>item</code> is the rundown item ID and <code>command</code> is <code>play</code>, <code>continue</code> or <code>stop</code>. The rundown does not need to be open in a controller. If it is open, the item plays from the controller's current state and its on-air indicator is updated. If the item's out is a time, the server stops it after that time. Returns <code>400</code> for invalid parameters and <code>404</code> for an unknown rundown or item. (Remember you can rename rundown items from SPX GUI)"
					},
					{
						"vers": "v1.1.1",
						"method": "GET",
						"active": false,
						"param": "/api/v1/getprojects",
						"info": "Returns projects as an array of strings."
					},
					{
						"vers": "v1.1.1",
						"method": "GET",
						"active": false,
						"param": "/api/v1/getrundowns?project=MyProject",
						"info": "Returns rundown names of a given project as an array of strings."
					},
					{
						"vers": "v1.3.0",
						"method": "GET",
						"active": false,
						"param": "/api/v1/allrundowns",
						"info": "Returns all projects and rundowns"
					},
					{
						"vers": "v1.1.1",
						"method": "GET",
						"param": "/api/v1/rundown/get",
						"info": "Returns the rundown currently open in the controller as json, in the same format as the rundown file. Returns <code>404</code> if no rundown is open."
					},
					{
						"vers": "v1.3.0",
						"method": "GET",
						"active": false,
						"param": "/api/v1/rundown/json?project=MyProject&rundown=FirstRundown",
						"info": "Returns content of a specific rundown as json data."
					},
					{
						"vers": "v1.3.0",
						"method": "POST",
						"active": false,
						"param": "/api/v1/rundown/json",
						"info": "Creates or updates a rundown file. This can be used for example with application extensions. POST <code>body:content</code> must contain valid rundown JSON data, otherwise SPX controller may not be able to read it. For more info search SPX Knowledge Base with keyword <code>api rundown/json</code>",
						"code": { project: "myProjectName", file: "newRundown.json", content: { comment: "Playlist generated by MyApp", templates: [{ "description": "First template", "playserver": "OVERLAY", "etc": "..." }, { "description": "Second template", "playserver": "OVERLAY", "etc": "..." }] } }
					},
					{
						"vers": "v1.1.1",
						"method": "GET",
						"active": false,
						"param": "/api/v1/getlayerstate",
						"info": "Returns current memory state of web-playout layers of the server (not UI). Please note, if API commands are used to load templates, this may not return them as expected!"
					},

					{
						"vers": "v1.1.3",
						"method": "GET",
						"active": false,
						"param": "/api/v1/gettemplates?project=MyProject",
						"info": "Returns templates and their settings from a given project."
					},
					{
						"vers": "v1.3.0",
						"method": "GET",
						"active": false,
						"param": "/api/v1/executeScript?file=win-open-calculator.bat",
						"info": "Execute a shell script/batch file in <code>ASSETS/scripts</code> folder using a shell associated with a given file extension."
					},

					{
						"vers": "v1.3.0",
						"method": "GET",
						"active": false,
						"param": "/api/v1/getFileList?assetsfolder=excel",
						"info": "Returns an array of filenames fround in a given subfolder of ASSETS, such as <code>excel</code>."
					},
					{
						"vers": "v1.3.0",
						"method": "POST",
						"active": false,
						"param": "/api/v1/saveCustomJSON",
						"info": "Creates or updates a JSON file in ASSETS/json folder. This can be used for persisting arbitrary data to a JSON file. The <code>content</code> property of the below example gets saved to <code>ASSETS/json/todoApp/myTodo.json</code>. Note the subfolder property is optional.",
						"code": { subfolder: "todoApp", filename: "myData.json", content: { note: "Get these done by the end of month", items: [{ "task": "Grow a beard", "done": false }, { "task": "Get a haircut", "done": true }] } }
					},
				]
			}

		]
	}
	res.render('view-api-v1', {
		layout: false,
		functionList: functionsDoc,
		version: global.vers
	});
});


// COMMON API  ----------------------------------------------------------

router.get('/version', async (req, res) => {
	// let data = {};
	// data.vendor = "SPX Graphics";
	// data.product = "SPX Solo";
	// data.version = global.vers;
	// data.id = global.pmac;
	// data.os = process.platform;
	// return res.status(200).json(data)
    let data = {};
    data.vendor = 'SPX Graphics';
    data.product = 'SPX Solo';
    data.version = global.vers;
    data.id = global.pmac;
    data.hostname = config.general.hostname || '';
    data.os = process.platform;
    data.rootFolder = spx.getStartUpFolder();
    data.uptime = {};
    let uptime = spx.getUpTime();
    data.uptime.seconds = uptime[0];
    data.uptime.text = uptime[1];

    // await spx.checkLicense();
    // if (global.licensed) {
    //     data.license.type = global.license.productBrand;
    //     data.license.expiration = global.license.expiration;
    //     data.license.days = spx.getLicenseDaysRemaining();
    // }

    if (global.env && global.env.vendor) {
        data.env = {};
        data.env.vendor = global.env.vendor;
        data.env.product = global.env.product;
        data.env.version = global.env.version;
    }
    return res.status(200).json(data);
}); // end version


router.get('/panic', spxAuth.CheckAPIKey, async (req, res) => {
	io.emit('SPXMessage2Client', { spxcmd: 'clearAllLayers' }); // clear webrenderers
	io.emit('SPXMessage2Controller', { APIcmd: 'RundownAllStatesToStopped' }); // stop UI and save stopped values to rundown
	if (spx.CCGServersConfigured) {
		PlayoutCCG.clearChannelsFromGCServer(req.body.server) // server is optional
	}
	return res.status(200).json({ status: 200, message: 'OK', info: 'Panic executed. Layers cleared forcefully.' })
}); // end panic


router.get('/feedproxy', spxAuth.CheckAPIKey, async (req, res) => {
	if (!req.query.url) {
		logger.error('URL missing from feedproxy parameters');
		return res.status(500).json({ type: 'error', message: 'URL missing from parameters' })
	}

	let URL = req.query.url
	URL = URL.replace(/meta-data/g, '');
	URL = URL.replace(/&path=/g, '###');
	axios.get(URL)
		.then(function (response) {
			res.header('Access-Control-Allow-Origin', '*')
			switch (req.query.format) {
				case 'xml':
					res.set('Content-Type', 'application/rss+xml')
					break;

				default:
					res.set('Content-Type', 'application/json')
					break
			}
			res.send(response.data)
		})
		.catch(function (error) {
			console.log(error);
			return res.status(500).json({ type: 'error', message: error.message })
		});
}); // end feedproxy


router.post('/feedproxy', spxAuth.CheckAPIKey, async (req, res) => {
	try {
		if (!req.body.url) {
			let errMsg = "url missing from feedproxy request. Make sure to have the correct JSON in your request.";
			throw { status: 404, message: errMsg };
		}

		if (req.body.postBody) {
			executePOSTRequest(req, res); // res handled in the function
		} else {
			executeGETRequest(req, res);  // res handled in the function
		}
	} catch (error) {
		res.status(error.status || 500).json({
			status: error.status || 500,
			error: error.message,
			info: "Search SPX Knowledge Base for more using keyword 'feedproxy'."
		});
	}
}); // end feedproxy post handler


async function executePOSTRequest(req, res) {
	try {
		const { url, headers, postBody } = req.body;

		if (!url || !headers || !postBody) {
			return res.status(400).json({ error: 'Missing required parameters in request body' });
		}

		let requestBody;
		try {
			requestBody = JSON.parse(postBody);
		} catch (error) {
			return res.status(400).json({ error: 'Invalid postBody format' });
		}

		const response = await fetch(url, {
			method: 'POST',
			body: JSON.stringify(requestBody),
			headers: headers
		});

		if (!response.ok) {
			return res.status(response.status).json({ error: `Target API returned an error: ${response.status} ${response.statusText}` });
		}
		const data = await response.json();
		res.status(response.status).json(data);
	} catch (error) {
		console.error('Error in executePOSTRequest:', error);
		res.status(500).json({ error: 'Failed to forward POST request' });
	}
}

function executeGETRequest(req, res) {
	// This handles response to the client
	// console.log('Using GET method', req.body);
	axios.
		get(req.body.url, {
			headers: req.body.headers
		})

		.then((response) => {
			res.header('Access-Control-Allow-Origin', '*')
			// console.log('Response status:', response.statusText, response.status, response.data);
			logger.verbose('executeGETRequest response: ' + response.status);
			res.status(response.status || 200).send(response.data);
		})

		.catch((error) => {
			if (error.response) {
				// console.log('data......', error.response.data);
				// console.log('status....', error.response.status);
				// console.log('headers...', error.response.headers);
				res.status(error.response.status || 500).send(error.response.data);
			} else if (error.request) {
				// The request was made but no response was received
				// console.log('request...', error.request);
				res.status(500).send(error.request);
			} else {
				// Something happened in setting up the request
				// console.log('Error msg...', error.message);
				res.status(500).send(error.message);
			}
		});
} // end executeGETRequest


router.get('/rundown/load/', spxAuth.CheckAPIKey, async (req, res) => {

	// Improved in 1.3.1 to sanitize input
	let file = await spx.strip(req.query.file);
	console.log('Loading rundown: ' + file);

	// Added in 1.3.1 check if it exists
	let project = file.split('/')[0];
	let rundown = file.split('/')[1];
	let fullPath = path.resolve(spx.getDatarootFolder(), project, 'data', rundown + '.json');
	if (!fs.existsSync(fullPath)) {
		let errMsg = 'Rundown [' + file + '] not found, cannot load it.';
		logger.error(errMsg);
		return res.status(404).json({ status: 404, message: errMsg });
	}

	let dataOut = {};
	dataOut.info = ack2
	dataOut.APIcmd = 'RundownLoad';
	dataOut.file = file;
	dataOut.apikey = req.query.apikey || '';
	io.emit('SPXMessage2Controller', dataOut);
	res.status(200).json(dataOut);
}); // end load


router.get('/rundown/stopAllLayers', spxAuth.CheckAPIKey, async (req, res) => {
	let dataOut = {};
	dataOut.info = ack2
	dataOut.APIcmd = 'RundownStopAll';
	dataOut.apikey = req.query.apikey || '';
	io.emit('SPXMessage2Controller', dataOut);
	res.status(200).json(dataOut);
}); // end stopAllLayers


router.get('/changeItemID', async (req, res) => {
	// Added in 1.0.15 - undocumented intentionally
	// ID button in SPX controller uses this API endpoint:
	// /api/v1/changeItemID?rundownfile=C:/SPX/DATAROOT/PROJECT/data/list.json&ID=0000001&newID=0000002

	try {
		let file = req.query.rundownfile || '';
		let oldI = req.query.ID || '';
		let newI = req.query.newID || '';
		if (!file || !oldI || !newI) {
			throw 'Missing data: file [' + file + '], old [' + oldI + '], new [' + newI + ']';
		}

		let datafile = path.normalize(file);
		let RundownData = await spx.GetJsonData(datafile);

		// First check for conflicts
		RundownData.templates.forEach((item, index) => {
			if (item.itemID === newI) {
				throw 'ID-conflict'
			}
		});

		RundownData.templates.forEach((item, index) => {
			if (item.itemID === oldI) {
				item.itemID = newI
			}
		});

		RundownData.updated = new Date().toISOString();

		RundownData = await spx.appendProjectFile(RundownData, datafile, "from changeItemID");
		global.rundownData = RundownData;
		await spx.writeFile(datafile, RundownData);
		logger.verbose('Changed item ID to ' + newI);
		return res.status(200).send('ID changed to ' + newI);
	} catch (error) {
		switch (error) {
			case 'ID-conflict':
				msg = 'ID conflict, ID was not changed.'
				lvl = 'warn'
				break;

			default:
				msg = 'Error in changeItemID: ' + error
				lvl = 'error'
		}
		logger[lvl](msg);
		return res.status(409).send('ID not changed');
	}
});


router.get('/changeItemData', async (req, res) => {
	// Added in 1.1.1
	// ID button in SPX controller uses this API endpoint:
	// /api/v1/changeItemData?rundownfile=C:/SPX/DATAROOT/PROJECT/data/list.json & ID=1234567890 & key=out & newValue=manual

	try {
		let file = req.query.rundownfile || '';
		let epoc = req.query.ID || '';
		let prop = req.query.key || '';
		let valu = req.query.newValue || '';
		if (!file || !epoc || !prop || !valu) {
			logger.warn('Missing data from changeItemData: file: [' + file + '], ID: [' + epoc + '], key: [' + prop + '], value: [' + valu + ']')
			throw 'Missing data, see log.';
		}
		let datafile = path.normalize(file);
		let RundownData = await spx.GetJsonData(datafile);
		RundownData.templates.forEach((item, index) => {
			if (item.itemID === epoc) {
				item[prop] = valu
			}
		});

		RundownData.updated = new Date().toISOString();
		RundownData = await spx.appendProjectFile(RundownData, datafile, "from changeItemData");
		global.rundownData = RundownData; // push to memory also for next take
		await spx.writeFile(datafile, RundownData);
		logger.verbose('ChangeItemData: file: [' + file + '], ID: [' + epoc + '], key: [' + prop + '], value: [' + valu + ']')
		return res.status(200).send(prop + ' changed to ' + valu);
	} catch (error) {
		console.log('Error', error);
		logger.error('changeItemData error', error);
		return res.status(409).send('Failed to change ' + prop + ' to ' + valu + '!');
	}
});



// CONTROLLER API -----------------------------------------------------------------------------

router.get('/item/play', spxAuth.CheckAPIKey, async (req, res) => {
	let dataOut = {};
	dataOut.info = ack2
	dataOut.status = 200;
	dataOut.message = 'OK';
	dataOut.APIcmd = 'ItemPlay';
	io.emit('SPXMessage2Controller', dataOut);
	res.status(200).json(dataOut);
});


router.get('/item/continue', spxAuth.CheckAPIKey, async (req, res) => {
	let dataOut = {};
	dataOut.status = 200;
	dataOut.message = 'OK';
	dataOut.info = ack2
	dataOut.APIcmd = 'ItemContinue';
	io.emit('SPXMessage2Controller', dataOut);
	res.status(200).json(dataOut);
}); // end item continue


router.get('/item/stop', spxAuth.CheckAPIKey, async (req, res) => {
	let dataOut = {};
	dataOut.status = 200;
	dataOut.message = 'OK';
	dataOut.info = ack2
	dataOut.APIcmd = 'ItemStop';
	io.emit('SPXMessage2Controller', dataOut);
	res.status(200).json(dataOut);
}); // end item stop


router.get('/rundown/focusNext/', spxAuth.CheckAPIKey, async (req, res) => {
	let dataOut = {};
	dataOut.info = ack2
	dataOut.APIcmd = 'RundownFocusNext';
	dataOut.apikey = req.query.apikey || '';
	io.emit('SPXMessage2Controller', dataOut);
	res.status(200).json(dataOut);
}); // end focusNext


router.get('/rundown/focusPrevious/', spxAuth.CheckAPIKey, async (req, res) => {
	let dataOut = {};
	dataOut.info = ack2
	dataOut.APIcmd = 'RundownFocusPrevious';
	dataOut.apikey = req.query.apikey || '';
	io.emit('SPXMessage2Controller', dataOut);
	res.status(200).json(dataOut);
}); // end focusPrevious


router.get('/rundown/focusFirst/', spxAuth.CheckAPIKey, async (req, res) => {
  let dataOut = {};
  dataOut.info    = ack2
  dataOut.APIcmd  = 'RundownFocusFirst';
  dataOut.apikey  = req.query.apikey || '';
  io.emit('SPXMessage2Controller', dataOut);
  res.status(200).json(dataOut);
}); // end focusFirst

router.get('/rundown/focusLast/', spxAuth.CheckAPIKey, async (req, res) => {
  let dataOut = {};
  dataOut.info    = ack2
  dataOut.APIcmd  = 'RundownFocusLast';
  dataOut.apikey  = req.query.apikey || '';
  io.emit('SPXMessage2Controller', dataOut);
  res.status(200).json(dataOut);
}); // end focusLast

router.get('/rundown/focusByID/:id', spxAuth.CheckAPIKey, async (req, res) => {
  let dataOut = {};
  dataOut.info    = ack2;
  dataOut.APIcmd  = 'RundownFocusByID';
  dataOut.apikey  = req.query.apikey || '';
  dataOut.itemID  = req.params.id;
  io.emit('SPXMessage2Controller', dataOut);
  res.status(200).send('Sent request to controller: ' + JSON.stringify(dataOut));
}); // end focusByID


// router.get('/rundown/focusFirst/', spxAuth.CheckAPIKey, async (req, res) => {
// 	res.status(501).json(notInSolo);
// }); // end focusFirst


// router.get('/rundown/focusLast/', spxAuth.CheckAPIKey, async (req, res) => {
// 	res.status(501).json(notInSolo);
// }); // end focusLast


// router.get('/rundown/focusByID/:id', spxAuth.CheckAPIKey, async (req, res) => {
// 	res.status(501).json(notInSolo);
// }); // end focusByID


// Item commands by ID are executed by the open controller (spx_gc.js handles
// ItemPlayID / ItemContinueID / ItemStopID), same as the focused-item commands.
function sendItemCommandByID(APIcmd) {
	return (req, res) => {
		let dataOut = {};
		dataOut.status = 200;
		dataOut.message = 'OK';
		dataOut.info = ack2;
		dataOut.APIcmd = APIcmd;
		dataOut.itemID = req.params.id;
		io.emit('SPXMessage2Controller', dataOut);
		res.status(200).json(dataOut);
	};
}

router.get('/item/play/:id', spxAuth.CheckAPIKey, sendItemCommandByID('ItemPlayID'));

router.get('/item/continue/:id', spxAuth.CheckAPIKey, sendItemCommandByID('ItemContinueID'));

router.get('/item/stop/:id', spxAuth.CheckAPIKey, sendItemCommandByID('ItemStopID'));


// Validates playout targets given to an API call: a web renderer layer
// and/or a CasparCG server, channel and layer. Unknown or disabled CasparCG
// servers are skipped with a warning. Returns { error } or the targets in
// playout handler format plus { warnings }.
function resolvePlayoutTargets({ playserver, playchannel, playlayer, webplayout }) {
	const warnings = [];
	const isLayerNumber = (v) => /^\d+$/.test(v) && parseInt(v) >= 1;
	const str = (v, fallback) => (v === undefined || v === null || String(v).trim() === '' ? fallback : String(v).trim());

	let web = str(webplayout, '-');
	if (web !== '-') {
		if (!isLayerNumber(web)) {
			return { error: 'Web renderer layer must be a positive number or "-", got [' + web + '].' };
		}
		if (parseInt(web) > 5) {
			warnings.push('Web renderer layer ' + web + ' is above 5: the renderer uses layer 5.');
		}
	}

	let server = str(playserver, '-');
	let channel = str(playchannel, '1');
	let layer = str(playlayer, '1');
	if (server !== '-') {
		const configured = (config.casparcg?.servers || []).find(
			(s) => String(s.name).toLowerCase() === server.toLowerCase()
		);
		if (!configured) {
			warnings.push('CasparCG server [' + server + '] is not configured in SPX, skipped.');
			server = '-';
		} else if (configured.disabled == true) {
			warnings.push('CasparCG server [' + server + '] is disabled in SPX, skipped.');
			server = '-';
		} else {
			server = configured.name;
			if (!isLayerNumber(channel) || !isLayerNumber(layer)) {
				return { error: 'CasparCG channel and layer must be positive numbers, got [' + channel + '-' + layer + '].' };
			}
		}
	}

	if (server === '-' && web === '-') {
		return { error: 'No playout target: give a web renderer layer and/or a configured CasparCG server.', warnings };
	}
	return { playserver: server, playchannel: channel, playlayer: layer, webplayout: web, warnings };
}


router.get('/invokeTemplateFunction/', spxAuth.CheckAPIKey, async (req, res) => {
	// Calls a function in a template that is already on air.
	// ?playserver=OVERLAY&playchannel=1&playlayer=19&webplayout=19&function=myFunc&params=Hello%20World
	const fail = (status, message, warnings) => {
		logger.warn('invokeTemplateFunction: ' + message);
		return res.status(status).json({ status, message, warnings });
	};

	const fn = String(req.query.function || '').trim();
	// The function name ends up in code run by CasparCG (and by the renderer's
	// legacy invoke path), so only plain JavaScript identifiers are allowed.
	if (!/^[A-Za-z_$][\w$]*$/.test(fn)) {
		return fail(400, 'Parameter function must be a plain JavaScript function name, got [' + fn + '].');
	}
	const params = req.query.params === undefined ? '' : String(req.query.params);

	const targets = resolvePlayoutTargets(req.query);
	if (targets.error) {
		return fail(400, targets.error, targets.warnings);
	}

	const result = await runPlayout({
		prepopulated: 'true',
		command: 'invoke',
		dataformat: 'json',
		playserver: targets.playserver,
		playchannel: targets.playchannel,
		playlayer: targets.playlayer,
		webplayout: targets.webplayout,
		function: fn, // web renderer
		params: params, // web renderer
		invoke: fn + '(' + JSON.stringify(params) + ')', // CasparCG
	});
	if (result.status !== 200) {
		return fail(500, String(result.body).replace('Error in /gc/playout: ', ''), targets.warnings);
	}

	res.status(200).json({
		status: 200,
		message: 'OK',
		function: fn,
		params: params,
		playserver: targets.playserver,
		playchannel: targets.playchannel,
		playlayer: targets.playlayer,
		webplayout: targets.webplayout,
		warnings: targets.warnings,
	});
}); // end invokeTemplateFunction


router.get('/invokeExtensionFunction/', spxAuth.CheckAPIKey, async (req, res) => {
	res.status(501).json(notInSolo);
}); // end invokeExtensionFunction


// SERVER API ----------------------------------------------------------------------------------

router.post('/directplayout', spxAuth.CheckAPIKey, async (req, res) => {
	// Plays, continues or stops a template with the given data, without a
	// rundown item. Optionally the data and on-air state are saved to a
	// rundown item (updateRundownItem.persist), and controllers showing that
	// rundown are refreshed (updateRundownItem.updateUI). Body example:
	// { casparServer, casparChannel, casparLayer, webplayoutLayer,
	//   relativeTemplatePath, out, DataFields: [{ field, value }], command,
	//   updateRundownItem: { updateUI, itemID, persist, project, rundown } }
	const commands = { play: 'play', continue: 'next', next: 'next', stop: 'stop' };
	const body = req.body;
	const fail = (status, message, warnings) => {
		logger.warn('directplayout: ' + message);
		return res.status(status).json({ status, message, warnings });
	};
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return fail(400, 'Request body must be a JSON object.');
	}

	const command = commands[String(body.command || '').trim().toLowerCase()];
	if (!command) {
		return fail(400, 'Property command must be play, continue or stop.');
	}

	// Template: must be a file inside ASSETS/templates.
	const templateRoot = path.resolve(spx.getStartUpFolder(), 'ASSETS', 'templates');
	const relpathIn = String(body.relativeTemplatePath || '').trim().replace(/\\/g, '/');
	if (!relpathIn) {
		return fail(400, 'Property relativeTemplatePath is required.');
	}
	const templateFile = path.resolve(templateRoot, '.' + path.posix.normalize('/' + relpathIn));
	const relpath = '/' + path.relative(templateRoot, templateFile).split(path.sep).join('/');
	if (relpath.startsWith('/..') || !fs.existsSync(templateFile) || !fs.statSync(templateFile).isFile()) {
		return fail(404, 'Template [' + relpathIn + '] not found in ASSETS/templates.');
	}

	// Data fields. Played values are cleaned up the same way as rundown item
	// values; values saved to a rundown item stay raw (see persist below).
	const dataFields = body.DataFields === undefined ? [] : body.DataFields;
	if (!Array.isArray(dataFields) || dataFields.some((f) => !f || typeof f !== 'object' || !f.field)) {
		return fail(400, 'Property DataFields must be an array of { field, value } objects.');
	}
	const rawFields = dataFields.map((f) => ({
		field: String(f.field),
		value: f.value === undefined || f.value === null ? '' : String(f.value),
	}));
	const fields = rawFields.map((f) => ({ field: f.field, value: spx.cleanUpString(f.value) }));

	const targets = resolvePlayoutTargets({
		playserver: body.casparServer,
		playchannel: body.casparChannel,
		playlayer: body.casparLayer,
		webplayout: body.webplayoutLayer,
	});
	if (targets.error) {
		return fail(400, targets.error, targets.warnings);
	}

	const spec = {
		command: command,
		relpath: relpath,
		dataformat: body.dataformat === 'xml' ? 'xml' : 'json',
		targets: targets,
		out: body.out === undefined || body.out === null ? 'manual' : String(body.out),
		fields: fields,
		rawFields: rawFields,
		link: null,
	};

	// Optional link to a rundown item.
	const link = body.updateRundownItem;
	if (link !== undefined && link !== null) {
		if (typeof link !== 'object' || !link.itemID || !link.project || !link.rundown) {
			return fail(400, 'Property updateRundownItem needs itemID, project and rundown.');
		}
		const project = String(link.project).trim();
		const rundown = String(link.rundown).trim();
		const dataroot = path.resolve(spx.getDatarootFolder());
		const datafile = path.resolve(dataroot, project, 'data', rundown + '.json');
		const relative = path.relative(dataroot, datafile);
		if (/[\\/]/.test(project) || /[\\/]/.test(rundown) || relative.split(path.sep)[0] === '..') {
			return fail(400, 'Property updateRundownItem has an invalid project or rundown name.');
		}
		if (!fs.existsSync(datafile)) {
			return fail(404, 'Rundown [' + project + '/' + rundown + '] not found.');
		}
		const persist = link.persist === true || link.persist === 'true';
		if (persist && command === 'next') {
			return fail(400, 'updateRundownItem.persist works with play and stop, not continue.');
		}
		spec.link = {
			project: project,
			rundown: rundown,
			datafile: datafile,
			itemID: String(link.itemID).trim(),
			persist: persist,
			updateUI: link.updateUI === true || link.updateUI === 'true',
		};
	}

	const result = await runDirectPlayout(spec);
	if (result.status !== 200) {
		return fail(result.status, result.message, targets.warnings);
	}

	res.status(200).json({
		status: 200,
		message: 'OK',
		command: body.command,
		relativeTemplatePath: relpath,
		playserver: targets.playserver,
		playchannel: targets.playchannel,
		playlayer: targets.playlayer,
		webplayout: targets.webplayout,
		warnings: targets.warnings,
	});
}); // end directplayout


// Plays, continues or stops a validated direct playout (see directplayout).
// When it plays with a numeric out, the server stops it again by running the
// same playout with "stop" (as an auto-out: controllers showing the linked
// rundown get an indicator update instead of a reload). Returns
// { status, message }.
async function runDirectPlayout(spec, isAutoOut = false) {
	const { command, targets, link } = spec;
	const playoutBody = {
		prepopulated: 'true',
		referrer: 'directplayout',
		autoOutByCaller: true, // auto-out is scheduled below
		command: command,
		relpath: spec.relpath,
		relpathCCG: spec.relpath.split('.htm')[0],
		dataformat: spec.dataformat,
		playserver: targets.playserver,
		playchannel: targets.playchannel,
		playlayer: targets.playlayer,
		webplayout: targets.webplayout,
		out: spec.out,
		fields: spec.fields,
	};

	let reload = false;
	let memoryWasEmpty = false;
	if (link) {
		const state = rundownState(link.project, link.rundown);
		if (link.persist) {
			// The handler saves into the rundown it has in memory, whichever
			// that is: only use memory when it is this rundown in an open
			// controller, otherwise make it read the file.
			playoutBody.updateRundownItem = { persist: true, project: link.project, rundown: link.rundown, itemID: link.itemID };
			playoutBody.forceFileReadOnce = !state.isOpen;
			// The handler saves these to the rundown and cleans them up for playout.
			playoutBody.fields = spec.rawFields;
			memoryWasEmpty = Object.keys(state.memory).length === 0;
			if (link.updateUI && isAutoOut) {
				// Data unchanged: only the item's on-air indicator.
				playoutBody.updateRundownItem.updateUI = state.isLoaded;
			} else if (link.updateUI) {
				// Controllers show the saved data only after a reload.
				reload = true;
			}
		} else if (link.updateUI && state.isLoaded && command !== 'next') {
			// Only the item's on-air indicator; only for the loaded rundown,
			// as duplicated rundowns share item IDs.
			playoutBody.updateRundownItem = { updateUI: true, itemID: link.itemID };
		}
	}

	const result = await runPlayout(playoutBody);
	if (memoryWasEmpty) {
		global.rundownData = {};
	}
	if (result.status !== 200) {
		return playoutFailure(result);
	}

	if (reload) {
		io.emit('SPXMessage2Controller', { APIcmd: 'RundownReload', project: link.project, rundown: link.rundown });
	}

	if (command === 'play') {
		const keys = autoOut.layerKeys(targets);
		if (link && link.persist) {
			keys.push(autoOut.itemKey(link.datafile, link.itemID));
		}
		scheduleAutoOut(spec.out, keys, 'direct playout of ' + spec.relpath, async () => {
			if (link && link.persist) {
				const item = currentRundownItem(link.datafile, link.itemID, rundownState(link.project, link.rundown).isOpen);
				if (!item || item.onair !== 'true') {
					return null; // linked item already stopped
				}
			}
			return runDirectPlayout({ ...spec, command: 'stop', fields: [], rawFields: [] }, true);
		});
	}
	return { status: 200, message: 'OK' };
}


router.get('/directplayout', spxAuth.CheckAPIKey, async (req, res) => {
	res.status(501).json(notInSolo);
}); // end directplayout


router.get('/getprojects', spxAuth.CheckAPIKey, async (req, res) => {
	res.status(501).json(notInSolo);
}); // end getprojects


router.get('/allrundowns', spxAuth.CheckAPIKey, async (req, res) => {
	res.status(501).json(notInSolo);
}); // end allrundowns


router.get('/getrundowns', spxAuth.CheckAPIKey, async (req, res) => {
	res.status(501).json(notInSolo);
}); // end getrundowns


router.get('/gettemplates', spxAuth.CheckAPIKey, async (req, res) => {
	res.status(501).json(notInSolo);
}); // end gettemplates


router.get('/getlayerstate', spxAuth.CheckAPIKey, async (req, res) => {
	res.status(501).json(notInSolo);
}); // end getlayerstate


router.get('/executeScript', spxAuth.CheckAPIKey, async (req, res) => {
	res.status(501).json(notInSolo);
}); // end executeScript file


router.get('/getFileList', spxAuth.CheckAPIKey, async (req, res) => {
	res.status(501).json(notInSolo);
}); // end getFileList


router.post('/saveCustomJSON', spxAuth.CheckAPIKey, async (req, res) => {
	res.status(501).json(notInSolo);
}); // end saveCustomJSON


// Runs the /gc/playout handler (without its login check) with the given
// request body. Resolves with { status, body } of its response.
async function runPlayout(body) {
	let result = { status: 500, body: '' };
	const playoutRes = {
		status(code) { result.status = code; return this; },
		send(data) { result.body = data || ''; return this; },
	};
	const { playout } = require('./routes-application.js'); // lazy: loaded after this file
	await playout({ body: body }, playoutRes);
	return result;
}


router.get('/controlRundownItemByID', spxAuth.CheckAPIKey, async (req, res) => {
	// Plays, continues or stops an item of a rundown file on the server, so
	// unlike /item/* this does not need the rundown open in a controller.
	// ?file=Project/Rundown&item=1234567890&command=play|continue|stop
	const commands = { play: 'play', continue: 'next', next: 'next', stop: 'stop' };
	const fail = (status, message) => {
		logger.warn('controlRundownItemByID: ' + message);
		return res.status(status).json({ status, message });
	};

	// String(): repeated query parameters arrive as arrays.
	const file = (await spx.strip(String(req.query.file || ''))).trim();
	const itemID = String(req.query.item || '').trim();
	const command = commands[String(req.query.command || '').trim().toLowerCase()];

	const [project, rundown, ...rest] = file.split('/');
	if (!project || !rundown || rest.length) {
		return fail(400, 'Parameter file must be given as Project/Rundown.');
	}
	if (!itemID) {
		return fail(400, 'Parameter item (rundown item ID) is required.');
	}
	if (!command) {
		return fail(400, 'Parameter command must be play, continue or stop.');
	}

	const dataroot = path.resolve(spx.getDatarootFolder());
	const datafile = path.resolve(dataroot, project, 'data', rundown + '.json');
	const relative = path.relative(dataroot, datafile);
	if (relative.split(path.sep)[0] === '..' || path.isAbsolute(relative)) {
		return fail(400, 'Rundown [' + file + '] is outside the dataroot folder.');
	}
	if (!fs.existsSync(datafile)) {
		return fail(404, 'Rundown [' + file + '] not found.');
	}

	const result = await runRundownItemCommand({ project, rundown, datafile, itemID, command });
	if (result.status !== 200) {
		return res.status(result.status).json(result);
	}

	let dataOut = {};
	dataOut.status = 200;
	dataOut.message = 'OK';
	dataOut.file = file;
	dataOut.item = itemID;
	dataOut.command = req.query.command;
	res.status(200).json(dataOut);
}); // end controlRundownItemByID


// Plays, continues or stops an item of a rundown file on the server (see
// controlRundownItemByID). When it plays an item with a numeric out, the
// server stops it again after that time, also when the rundown is open in a
// controller (which runs the same timer: whichever stops it first cancels
// the other). Returns { status, message }.
async function runRundownItemCommand({ project, rundown, datafile, itemID, command }) {
	// If this rundown is open in a controller, its in-memory copy is the
	// current state: play from it, as a click in that controller would.
	// Otherwise read the file, and leave the memory as it was.
	const state = rundownState(project, rundown);
	const memoryWasEmpty = Object.keys(state.memory).length === 0;

	const result = await runPlayout({
		datafile: datafile,
		epoch: itemID,
		command: command,
		forceFileReadOnce: !state.isOpen,
		autoOutByCaller: true, // auto-out is scheduled below
		// Update the item indicator in controllers showing this rundown.
		// Only for the loaded rundown (a duplicated rundown shares item
		// IDs), and not for "next", which the controller would treat as
		// a play/stop toggle.
		updateRundownItem: state.isLoaded && command !== 'next' ? { updateUI: true, itemID: itemID } : undefined,
	});
	if (memoryWasEmpty && !state.isOpen) {
		global.rundownData = {};
	}
	if (result.status !== 200) {
		return playoutFailure(result);
	}

	if (command === 'play') {
		const item = currentRundownItem(datafile, itemID, false); // play saved it to the file
		if (item) {
			const keys = [autoOut.itemKey(datafile, itemID), ...autoOut.layerKeys(item)];
			scheduleAutoOut(item.out, keys, 'rundown item ' + project + '/' + rundown + ' [' + itemID + ']', async () => {
				const current = currentRundownItem(datafile, itemID, rundownState(project, rundown).isOpen);
				if (!current || current.onair !== 'true') {
					return null; // already stopped
				}
				return runRundownItemCommand({ project, rundown, datafile, itemID, command: 'stop' });
			});
		}
	}
	return { status: 200, message: 'OK' };
}


// How a rundown relates to the controller: loaded in memory (the last
// rundown a controller opened), and open in a connected controller. The
// memory keeps the rundown after its tab is closed, so "open" also requires
// a connected controller.
function rundownState(project, rundown) {
	const memory = global.rundownData || {};
	const controllerConnected = [...io.sockets.sockets.values()].some(
		(s) => String(s.SPXClientName || '').startsWith('SPX_CONTROLLER')
	);
	const isLoaded = memory.project === project && memory.rundown === rundown;
	return { memory: memory, isLoaded: isLoaded, isOpen: controllerConnected && isLoaded };
}


// A rundown item's current data: from memory when the rundown is open in a
// controller (its state is the current one), otherwise from the file.
function currentRundownItem(datafile, itemID, fromMemory) {
	try {
		const data = fromMemory ? global.rundownData : JSON.parse(fs.readFileSync(datafile, 'utf8'));
		return (data.templates || []).find((t) => t.itemID == itemID);
	} catch (error) {
		logger.warn('Cannot read item [' + itemID + '] of ' + datafile + ': ' + error);
		return undefined;
	}
}


// Turns a failed playout handler response into { status, message }.
function playoutFailure(result) {
	const message = String(result.body).replace('Error in /gc/playout: ', '');
	const status = /not found on the rundown/.test(message) ? 404 : 500;
	return { status: status, message: message };
}


// Schedules the server-side auto-out of an API playout when `out` is a
// number of milliseconds. stop() runs when the time is up, unless a play or
// stop of the same item or on the same layers cancels it first (see
// utils/spx_autoout.js). stop() resolves with { status, message }, or null
// when there was nothing to stop.
function scheduleAutoOut(out, keys, what, stop) {
	const ms = parseInt(out);
	if (isNaN(ms) || ms < 0) {
		return;
	}
	logger.verbose('Auto-out of ' + what + ' in ' + ms + ' ms.');
	autoOut.schedule(keys, ms, async () => {
		try {
			const result = await stop();
			if (!result) {
				logger.verbose('Auto-out of ' + what + ' skipped: already stopped.');
			} else if (result.status !== 200) {
				logger.warn('Auto-out of ' + what + ' failed: ' + result.message);
			}
		} catch (error) {
			logger.error('Auto-out of ' + what + ' failed: ' + error);
		}
	});
}


router.get('/rundown/get', spxAuth.CheckAPIKey, async (req, res) => {
	// The rundown currently open in the controller, as kept in memory
	// (same format as the rundown file).
	if (!global.rundownData || !global.rundownData.templates) {
		return res.status(404).json({ status: 404, message: 'No rundown is currently open in SPX controller.' });
	}
	res.status(200).json(global.rundownData);
}); // end get current rundown as JSON


router.get('/rundown/json', spxAuth.CheckAPIKey, async (req, res) => {
	res.status(501).json(notInSolo);
}); // end get specific rundown as JSON


router.post('/rundown/json', spxAuth.CheckAPIKey, async (req, res) => {
	res.status(501).json(notInSolo);
}); // end create or update rundown as JSON

module.exports = router;
