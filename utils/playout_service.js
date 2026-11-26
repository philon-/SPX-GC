// Playout of rundown items and prepopulated graphics: the logic behind
// POST /gc/playout, also used by the API routes (/api/v1/...) that play
// items on the server.
//
// playout(body) takes the /gc/playout request body and resolves with
// { status, body } for the HTTP response. It reads and writes rundowns only
// through the rundown store (utils/rundown_store.js), under the rundown
// file's lock.

const path = require('path');
const fs = require('fs');
const logger = require('./logger.js');
const spx = require('./spx_server_functions.js');
const PlayoutCCG = require('./playout_casparCG.js');
const PlayoutWEB = require('./playout_webplayer.js');
const autoOut = require('./spx_autoout.js');
const rundownStore = require('./rundown_store.js');

async function playout(body) {
	// body: the /gc/playout request body (command, datafile, epoch, ...).
	// Resolves with { status, body } for the HTTP response.
	//
	// Handles playout commands of the rundown items in the controller.
	// This function will collect data from datafile and will send out "stupid" 
	// playout commands to all needed renderer interfaces.
	//
	// This will also persist the onair state to rundown file.
	// 
	// Rundown data comes from the rundown store (utils/rundown_store.js), one
	// entry per file, and the whole read-modify-write runs under that file's
	// lock. forceFileReadOnce re-reads the file first (API calls on rundowns
	// that are not open in a controller).
	try {
		if (body.command == 'customAction') {
			PlayoutWEB.webPlayoutController({ spxcmd: 'customAction', id: body.id, webplayout: body.webplayout })
			return { status: 200, body: '' };
		}

		let RundownFile = path.normalize(body?.datafile || '') // file reference (in a normal call)
		if (body?.updateRundownItem?.persist) {
			let project = body?.updateRundownItem?.project || '';
			let rundown = body?.updateRundownItem?.rundown || '';
			RundownFile = path.resolve(spx.getDatarootFolder(), project, 'data', rundown + '.json');
		}
		let usesRundown = body?.prepopulated != "true" || !!body?.updateRundownItem?.persist;

		const run = () => playoutLocked(body, RundownFile, usesRundown);
		await (usesRundown ? rundownStore.withLock(RundownFile, run) : run());
		return { status: 200, body: '' };
	} // end try
	catch (error) {
		logger.error('ERROR in /gc/playout. ' + error);
		return { status: 500, body: 'Error in /gc/playout: ' + error };
	};
} // playout


// The body of playout(), run under the rundown file's lock when it uses a
// rundown. Throws on errors.
async function playoutLocked(body, RundownFile, usesRundown) {
	let templateIndex = -1;
	let dataOut = {}; // new object
	dataOut.fields = []; // init it with an empty arr as placeholder
	let RundownData = ""  // file JSON
	let preventSave = false;
	let forceDiskRead = body.forceFileReadOnce ? true : false; // Added in 1.3.0. Read Release Notes!
	let legacyAutoOutMs = null; // auto-out of /gc/playout API callers, see below
	let itemID = null; // Added in 1.3.2
	let ItemData = {}; // Modified in 1.3.2

	if (!usesRundown) {
		// data in pre-generated coming in. So we can just pass that along.
		logger.verbose('Playout command prepopulated [' + body.command + '] template [' + body.relpath + '].');
		dataOut = body;
		if (body.command != 'invoke' && body.command != 'stop') { // added stop in 1.1.4
			dataOut.relpathCCG = body.relpath.split('.htm')[0]; // casparCG needs template path without extension
		}
		preventSave = true;
	} else {
		// Normal method of working (or when using directplayout persist request)
		// We collect data from rundown first.
		itemID = body?.epoch || body?.updateRundownItem?.itemID || '';
		logger.verbose('Playout command [' + body.command + '] item [' + itemID + '] of [' + RundownFile + '].');

		RundownData = await rundownStore.load(RundownFile, { fresh: forceDiskRead });
		if (!RundownData || !Array.isArray(RundownData.templates)) {
			throw 'Rundown [' + RundownFile + '] not found or has no items. Aborting ' + body.command + ' command.';
		}
		let projectFormat = RundownData.projectFormat || 'SPX';

		RundownData.templates.forEach((template, index) => {
			logger.debug('Matching ' + index + ': [' + template.itemID + '] (' + template.description + ') and [' + itemID + ']');
			if (template.itemID == itemID) {
				templateIndex = index;
			}
		});

		if (templateIndex == -1) {
			throw 'Requested itemID [' + itemID + '] not found on the rundown [' + RundownFile + ']! Aborting ' + body.command + ' command.';
		}

		ItemData = RundownData.templates[templateIndex];

		dataOut.ografProps = ItemData.ografProps; // OGRAF Support
		dataOut.projectFormat = projectFormat;       // OGRAF Support
		dataOut.graphicPath = ItemData.graphicPath;   // OGRAF Support

		dataOut.relpath = ItemData.relpath;
		dataOut.relpathCCG = ItemData.relpath.split('.htm')[0]; // casparCG needs template path without htm/html -extension. 
		dataOut.playserver = ItemData.playserver;
		dataOut.playchannel = ItemData.playchannel;
		dataOut.playlayer = ItemData.playlayer;
		dataOut.webplayout = ItemData.webplayout;
		dataOut.out = ItemData.out; // 1.3.0 only used with direct API calls
		dataOut.dataformat = ItemData.dataformat || 'json'; // Changed to JSON in 1.3.0
		ItemData.DataFields.forEach(item => {
			// We pass data as custom JSON format and the format is changed
			// downstream in the playout controller as per renderer's needs.
			let FieldItem = {};
			if (item.field) {
				FieldItem.field = item.field;
				if (item.value) { // TODO: bug alert (&& item.field.value) check if there IS value to begin with. Added 29.01.2021
					FieldItem.value = spx.cleanUpString(item.value); // Added in 1.3.2
				}
				dataOut.fields.push(FieldItem);
			}
		});
		dataOut.fields.push({ 'field': 'epochID', 'value': itemID });
	} // else (ie read from JSON)

	let playOutCommand = "";
	if (body.command == 'playonce') {
		playOutCommand = "play";
		preventSave = true;
		logger.verbose('Note playonce command received, preventSave = true');
	} else {
		playOutCommand = body.command;
	}


	// Added in 1.3.2 if directplayout is used, we need to
	// update incoming data with the itemID.
	// If data from API, then override
	if (body?.updateRundownItem?.persist) {
		let overrideTemplateIndex = -1;
		RundownData.templates.forEach((template, index) => {
			if (template.itemID == body.updateRundownItem.itemID) {
				// console.log('Template FOUND', index, template.description);
				overrideTemplateIndex = index;
				template.DataFields.forEach((templateField, dfIndex) => {
					// console.log('templateField', dfIndex)
					body.fields.forEach((dataField, daIndex) => {
						// note, "fields" not "DataFields"
						// console.log('.....dataField', daIndex)
						if (templateField.field == dataField.field) {
							RundownData.templates[overrideTemplateIndex].DataFields[dfIndex].value = dataField.value;
						}
					});
				})
			}
		});
		// Rundown files keep raw values (as above); clean them up for
		// rendering, as is done for rundown items.
		dataOut = Object.assign({}, body, {
			fields: (body.fields || []).map((f) => ({ field: f.field, value: spx.cleanUpString(String(f.value ?? '')) })),
		});
	}


	// console.log('RundownData after mods', RundownData.templates[templateIndex]);



	// Commands that load the template need it to exist; checked before
	// anything is sent. (Stop, continue etc. still work for a template
	// that was removed while on air.)
	if (['play', 'preview', 'autoPlayLocal'].includes(playOutCommand) && dataOut.relpath) {
		let templateAbsPath = path.join(spx.getStartUpFolder(), 'ASSETS', 'templates', dataOut.relpath);
		if (!fs.existsSync(templateAbsPath)) {
			throw (playOutCommand + ' warning! Template not found: ' + dataOut.relpath);
		}
	}

	switch (playOutCommand) {

		// == PREVIEW ===================================================
		case 'preview':

			// Send PlayoutWEB.functionCalls() if any ---------------------
			if (dataOut.webplayout != '-' && config.general.preview != 'none') {
				dataOut.webplayout = '1'; // force to layer 1! Changed to string in 1.0.15
				logger.verbose('Webplayout PREVIEW: ' + dataOut.webplayout);
				dataOut.playmode = 'preview';
				dataOut.spxcmd = 'playTemplate';
				PlayoutWEB.webPlayoutController(dataOut);
			} else {
				logger.verbose('No Webplayout playout');
			}
			break;

		// == AUTOPLAY ==================================================
		case 'autoPlayLocal':
			// Update local renderer when a rundown is reloaded
			logger.verbose('Webplayout autoPlayLocal: ' + dataOut.webplayout);
			dataOut.spxcmd = 'playTemplate';
			dataOut.modify = 'autoPlayLocal';
			PlayoutWEB.webPlayoutController(dataOut);
			break;

		// == PLAY =====================================================
		case 'play':
			let playingSomewhere = false; // Added in 1.3.0


			// console.log('DataOut', dataOut);


			// Send PlayoutCCG.functionCalls() if any ---------------------
			if (dataOut.playserver && dataOut.playserver != '-' && spx.CCGServersConfigured()) { // 1.1.3 added dataOut.playserver
				dataOut.command = "ADD";
				logger.verbose('CasparCG play: [' + dataOut.relpathCCG + '] ' + dataOut.playserver + '/' + dataOut.playchannel + '-' + dataOut.playlayer);
				playingSomewhere = true;
				PlayoutCCG.playoutController(dataOut);
			} else {
				logger.verbose('No CasparCG playout');
			}

			// Send PlayoutWEB.functionCalls() if any ---------------------
			if (dataOut.webplayout && dataOut.webplayout != '-') {
				logger.verbose('Webplayout PLAY: ' + dataOut.webplayout);
				dataOut.spxcmd = 'playTemplate';
				playingSomewhere = true;
				PlayoutWEB.webPlayoutController(dataOut);
			} else {
				logger.warn('No Webplayout playout layer given');
			}

			// iterate all templates and allow only the latest update
			// (for same playout) to be on-air at once
			if (RundownData.templates) {
				// prepopulated does not necessarily have "templates"
				RundownData.templates.forEach((item, index) => {
					let thisOnair = item.onair || '';
					let thisServer = item.playserver || '-';
					let thisChannel = item.playchannel || '1';
					let thisLayer = item.playlayer || '1';
					let thisWeb = item.webplayout || '-';
					let thisOutput = thisServer.trim() + thisChannel.trim() + thisLayer.trim() + thisWeb.trim() + thisOnair.trim();

					let dataOnair = 'true' // because we are in play;
					let dataServer = dataOut.playserver || '-';
					let dataChannel = dataOut.playchannel || '1';
					let dataLayer = dataOut.playlayer || '1';
					let dataWeb = dataOut.webplayout || '-';
					let dataOutput = dataServer.trim() + dataChannel.trim() + dataLayer.trim() + dataWeb.trim() + dataOnair.trim();

					if (index != templateIndex && thisOutput == dataOutput) {
						RundownData.templates[index].onair = 'false';
					}

					if (index == templateIndex && playingSomewhere) {
						RundownData.templates[index].onair = 'true';
					}
				});
			}

			// API Call executed. Should we set an autostop? (Not when the
			// API route handles auto-out itself, see utils/spx_autoout.js.)
			if ((forceDiskRead || body.referrer == 'directplayout') && !body.autoOutByCaller) {
				let numeric = parseInt(dataOut.out);
				if (isNaN(numeric)) {
					logger.verbose('API call: out was not a number, skipping autostop.');
				} else {
					logger.verbose('API call: autostop item in ' + numeric + ' ms.');
					legacyAutoOutMs = numeric; // scheduled below
				}
			}
			break;

		// == NEXT / aka CONTINUE  =====================================
		case 'next':

			// Prepopulated playouts have no rundown item to mark on air.
			if ((dataOut.playserver != '-' || dataOut.webplayout != '-') && RundownData.templates?.[templateIndex]) {
				RundownData.templates[templateIndex].onair = 'true';
			}

			// Send PlayoutCCG.functionCalls() if any ---------------------
			if (dataOut.playserver != '-') {
				dataOut.command = "NEXT";
				logger.verbose('CasparCG next: [' + dataOut.relpathCCG + '] ' + dataOut.playserver + '/' + dataOut.playchannel + '-' + dataOut.playlayer);
				PlayoutCCG.playoutController(dataOut);
			} else {
				logger.verbose('No CasparCG playout');
			}

			// Send PlayoutWEB.functionCalls() if any ---------------------
			if (dataOut.webplayout != '-') {
				logger.verbose('Webplayout NEXT: ' + dataOut.webplayout);
				dataOut.spxcmd = 'nextTemplate';
				PlayoutWEB.webPlayoutController(dataOut); // refactored 20.08.2020 (note, this function handles all play, stop, next, update commands)
				// io.emit('SPXMessage2Client', dataOut);
			} else {
				logger.verbose('No Webplayout playout');
			}
			break;

		// == STOP ===================================================
		case 'stop':
			await playoutSTOP(dataOut);
			if (templateIndex > -1 && RundownData.templates[templateIndex]) {
				// Added check in 1.3.0
				RundownData.templates[templateIndex].onair = 'false';
			}
			break;

		// == UPDATE ===================================================
		case 'update':
			logger.verbose('Updating [' + dataOut.relpath + ']');
			// RundownData.templates[templateIndex].onair='true'; // yes. no?

			if (dataOut.playserver != '-') {
				// TODO: Update functions not deeply properly tested.
				dataOut.command = "UPDATE";
				logger.verbose('CasparCG update: [' + dataOut.relpathCCG + '] ' + dataOut.playserver + '/' + dataOut.playchannel + '-' + dataOut.playlayer + ', dataOut: ', dataOut);
				PlayoutCCG.playoutController(dataOut);
			} else {
				logger.verbose('No CasparCG playout');
			}

			// Send PlayoutWEB.functionCalls() if any
			if (dataOut.webplayout != '-') {
				logger.verbose('Webplayout UPDATE: ' + dataOut.webplayout);
				dataOut.spxcmd = 'updateTemplate';
				dataOut.fields = body.fields;
				PlayoutWEB.webPlayoutController(dataOut);
			} else {
				logger.verbose('No Webplayout playout');
			}
			break;

		// == INVOKE ===================================================
		case 'invoke':
			logger.verbose('Invoke [' + dataOut.invoke + ']');
			// Example of expected dataOut down stream from here:
			// dataOut.command = "invoke"
			// dataOut.invoke  = "myTemplateFunction('hello world')"
			if (dataOut.playserver != '-') {
				dataOut.command = "INVOKE";
				PlayoutCCG.playoutController(dataOut);
			}

			if (dataOut.webplayout != '-') {
				dataOut.spxcmd = 'invokeFunction';
				PlayoutWEB.webPlayoutController(dataOut);
			} // if web
			break;

		default:
			logger.warn('/gc/playout did not recognize command "' + playOutCommand + '".');
			break;
	}

	// A play or stop replaces any pending API auto-out of this item or on
	// these layers (see utils/spx_autoout.js).
	if (playOutCommand == 'play' || playOutCommand == 'stop') {
		let autoOutKeys = autoOut.layerKeys(dataOut);
		if (itemID && templateIndex > -1) {
			autoOutKeys.push(autoOut.itemKey(RundownFile, itemID));
		}
		autoOut.cancel(autoOutKeys);
		// Callers of /gc/playout that do not schedule auto-out themselves
		// (forceFileReadOnce or referrer 'directplayout' without
		// autoOutByCaller): stop after `out` ms. Cancelled like the above.
		if (legacyAutoOutMs !== null) {
			const stopData = Object.assign({}, dataOut);
			autoOut.schedule(autoOutKeys, legacyAutoOutMs, () => playoutSTOP(stopData));
		}
	}

	// Added in 1.3.2 / updateRundownItem in the UI if set
	if (body?.updateRundownItem?.updateUI) {
		logger.verbose('API call: updateRundownItem in the UI.');
		io.emit('SPXMessage2Client', {
			spxcmd: 'updateRundownItem',
			itemID: body.updateRundownItem.itemID,
			relpath: dataOut.relpath,
			command: playOutCommand
		});
	}

	// Persist. The store entry is RundownData itself, so memory is already
	// up to date; play and stop are also written to disk.
	// Prepopulated playouts (no rundown item behind them) have no rundown data.
	if (RundownData && RundownData.templates) {
		RundownData.updated = new Date().toISOString();
		await spx.appendProjectFile(RundownData, RundownFile, "from gc/playout");
		if (playOutCommand == 'play' || playOutCommand == 'stop') {

			if (body?.updateRundownItem?.persist) {
				preventSave = false;
			}

			if (preventSave) {
				logger.verbose('preventSave enabled, no need to persist to disk.');
			} else {
				logger.verbose('Persisting rundown data to disk....');
				await spx.writeFile(RundownFile, RundownData);
			}
		}
	}

} // playoutLocked ended


async function playoutSTOP(dataOut) {
	logger.verbose('Stopping [' + dataOut.relpath + ']');
	if (dataOut.playserver != '-') {
		dataOut.command = "STOP";
		logger.verbose('CasparCG stop: [' + dataOut.relpathCCG + '] ' + dataOut.playserver + '/' + dataOut.playchannel + '-' + dataOut.playlayer);
		PlayoutCCG.playoutController(dataOut);
	} else {
		logger.verbose('No CasparCG playout');
	}

	if (dataOut.webplayout != '-') {
		logger.verbose('Webplayout STOP: ' + dataOut.webplayout);
		dataOut.spxcmd = 'stopTemplate';
		PlayoutWEB.webPlayoutController(dataOut);
	} else {
		logger.verbose('No Webplayout playout');
	}
}  // playoutSTOP ended

module.exports = { playout };
