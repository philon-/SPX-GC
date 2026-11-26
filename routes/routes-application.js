
// --------------------------------------------
// server routes (at "/")
// --------------------------------------------
var express = require("express");
const router = express.Router();
const path = require('path');
const fs = require('fs');
const moment = require('moment');
const logger = require('../utils/logger');
logger.debug('Application-route loading...');
const spx = require('../utils/spx_server_functions.js');
const cfg = require('../utils/spx_getconf.js');
const PlayoutCCG = require('../utils/playout_casparCG.js');
const rundownStore = require('../utils/rundown_store.js');
const playoutService = require('../utils/playout_service.js');
const spxAuth = require('../utils/spx_auth.js');
const jsdom = require("jsdom");
const { JSDOM } = jsdom;
const { resolveInside, isPlainName } = require('../utils/spx_paths.js');
const access = require('../utils/spx_access.js');

// Project and rundown names in URLs become file system paths: they must be
// plain names (no "/", "\" or ".."). Express decodes %2F before this runs.
for (const name of ['foldername', 'filename', 'folder', 'file']) {
	router.param(name, (req, res, next, value) => {
		if (isPlainName(value)) return next();
		logger.warn('Refused invalid ' + name + ' in URL: ' + value);
		return res.status(400).send('Invalid ' + name + '.');
	});
}

// The same for names and rundown paths that the UI sends in request bodies:
// names must be plain, and full rundown paths must be inside the dataroot.
const BODY_NAME_FIELDS = ['showFolder', 'foldername', 'filebasename', 'foldname', 'filename', 'foldnam', 'orgname', 'newname'];
const BODY_RUNDOWN_PATH_FIELDS = ['datafile', 'rundownfile', 'RundownFile'];
router.use((req, res, next) => {
	const body = req.body;
	if (!body || typeof body !== 'object') return next();
	const refuse = (field, value) => {
		logger.warn('Refused invalid ' + field + ' in ' + req.path + ': ' + value);
		return res.status(400).send('Invalid ' + field + '.');
	};
	for (const field of BODY_NAME_FIELDS) {
		const value = body[field];
		if (value !== undefined && value !== '' && !isPlainName(value)) return refuse(field, value);
	}
	for (const field of BODY_RUNDOWN_PATH_FIELDS) {
		const value = body[field];
		if (value && !resolveInside(spx.getDatarootFolder(), path.resolve(String(value)))) return refuse(field, value);
	}
	const link = body.updateRundownItem;
	if (link && typeof link === 'object') {
		if ((link.project && !isPlainName(link.project)) || (link.rundown && !isPlainName(link.rundown))) {
			return refuse('updateRundownItem', link.project + '/' + link.rundown);
		}
	}
	next();
});

// ROOT ROUTES ----------------------------------------------------------------------------------------------

router.get('/', spxAuth.CheckLogin, spx.getNotificationsMiddleware, async function (req, res) {
	let currVer = vers;
	let greeting = config.general.greeting || '';

	let recents = config.general.recents || [] // added in 1.1.0
	let disableConfigUI = config.general.disableConfigUI || false // added in 1.1.1
	res.render('view-home', {
		layout: false,
		greeting: greeting,
		curVerInfo: req.curVerInfo,
		currVer: currVer,
		user: req.session.user,
		recents: recents,
		disableConfigUI: disableConfigUI,
		config: config,
		showMessage: req.session.showMessage
	});
	req.session.showMessage = null;
}); // get / end

router.get('/admin', spxAuth.CheckLogin, function (req, res) {
	res.render('view-admin', { layout: false });
}); // get /admin end

router.get('/fileBrowser', spxAuth.CheckLogin, function (req, res) {
	// added in 1.1.1
	res.render('view-fileBrowser', { layout: false });
}); // get /fileBrowser end

router.get('/templates/empty.html', function (req, res) {
	res.render('view-empty', { layout: false });
}); // get /templates/empty.html end

router.get(['/renderer/index.html', '/renderer'], function (req, res) {
	let hideCursor = false;

	// Added in 1.3.0
	if (global.config.general.hideRendererCursor && global.config.general.hideRendererCursor == true) {
		hideCursor = true;
	}

	// Added in 1.3.0
	let outputSize = getResolutionFromConfig(global.config, req.query);

	res.render('view-renderer', {
		layout: false,
		width: outputSize.width,
		height: outputSize.height,
		hideCursor: hideCursor
	});
}); // get /renderer end

router.get('/renderer/scalable', function (req, res) {
	// Added in 1.3.0
	let outputSize = getResolutionFromConfig(global.config, req.query);
	res.render('view-rendererscalable', {
		layout: false,
		width: outputSize.width,
		height: outputSize.height
	});
}); // get /renderer/scalable end

router.get('/renderwindow/:type', function (req, res) {
	// Added in 1.3.0
	let outputSize = getResolutionFromConfig(global.config, req.query);
	let viewFile = '';
	viewFile = 'view-rendererscalable';

	if (viewFile == '') {
		res.send('Invalid URL');
	} else {
		res.render(viewFile, {
			layout: false,
			width: outputSize.width,
			height: outputSize.height,
			mode: req.params.type
		});
	}
}); // get /renderwindow/:type end

router.get('/login', function (req, res) {
	// Added in 1.3.2
	res.render('view-login', { layout: false });
}); // login

router.get('/logout', spxAuth.Logout, function (req, res) {
	res.redirect('/');
}); // get /logout end

router.post('/', spxAuth.CheckLogin, function (req, res) {
	//logger.info('User "' + req.session.user + '" logged in');
	res.redirect('/');
}); // post / end

router.post('/saveauthpolicy', async function (req, res) {
	// Saves the choice of the first-run auth policy page (login or no
	// login). Allowed only while that page is what SPX shows (a username
	// without a password), or for a logged-in user. Otherwise anyone could
	// switch login off.
	const firstRun = !!config.general.username && !config.general.password;
	if (!firstRun && !access.hasLoginSession(req)) {
		logger.warn('saveauthpolicy: refused, auth policy is already set.');
		return res.status(403).send('Auth policy is already set. Log in to change it.');
	}

	let user = "";
	let pass = "";
	if (req.body.policy == "1") {
		if (!req.body.username || !req.body.password) {
			return res.status(400).send('Username and password are required.');
		}
		logger.debug('saveauthpolicy: Use auth, set user-pass fields in config')
		user = req.body.username;
		pass = spx.hash(req.body.password);
	} else {
		logger.debug('saveauthpolicy: Dont use auth, clear user-pass fields in config');
	}

	try {
		const configFile = global.configfileref;
		const configData = await GetJsonData(configFile);
		configData.general.username = user;
		configData.general.password = pass;
		await spx.writeFile(configFile, configData);
		await cfg.readConfig();
	} catch (error) {
		logger.error('saveauthpolicy: error while saving config: ' + error);
	}
	res.redirect('/');
}); // post /saveauthpolicy end

router.get('/config', spxAuth.CheckLogin, async (req, res) => {
	// show application config (send global.config as "config" data to the view, see options object below)
	let recents = config.general.recents || [] // added in 1.1.0
	let disableConfigUI = config.general.disableConfigUI || false // added in 1.1.1
	res.render('view-appconfig', {
		layout: false,
		config: config,
		user: req.session.user,
		configfile: configfileref,
		recents: recents,
		disableConfigUI: disableConfigUI
	});
}); // get /config end

router.post('/config', spxAuth.CheckLogin, async (req, res) => {
	// save incoming json form data to config.json and reload the page
	let ConfigData = req.body;
	if (req.body.NewName && req.body.NewHost && req.body.NewPort) {
		// new server was added
		var obj = {};
		obj["name"] = req.body.NewName;
		obj["host"] = req.body.NewHost;
		obj["port"] = req.body.NewPort;
		if (!ConfigData.casparcg) {
			// we are adding new servers to non-existing array
			ConfigData.casparcg = {};
		}

		if (ConfigData.casparcg.servers) {
			ConfigData.casparcg.servers.push(obj);
		} else {
			ConfigData.casparcg.servers = [obj];
		}
	}

	if (ConfigData.casparcg && Array.isArray(ConfigData.casparcg.servers)) {
		// remove casparcg servers with missing data
		ConfigData.casparcg.servers = ConfigData.casparcg.servers.filter(
			(element) => !(element.name == "" || element.host == "" || element.port == "")
		);
	}

	// remove un-necessary temp-fields
	delete ConfigData.NewName;
	delete ConfigData.NewHost;
	delete ConfigData.NewPort;

	// Added in 1.1.1
	ConfigData.general.recents = config.general.recents || []

	// Overwrite config.json
	// let datafile = './config.json'; // hey! This is wrong!
	let datafile = global.configfileref; // hey! This is wrong!
	logger.debug('Saving config file ' + datafile + '...');

	try {
		await spx.writeFile(datafile, ConfigData);
		await cfg.readConfig();
		res.render('view-appconfig', { recents: ConfigData.general.recents, layout: false, config: config, message: 'Changes saved', user: req.session.user });
	} catch (error) {
		logger.error('router.post/config - Error while saving file: ' + error);
		res.render('view-appconfig', { recents: ConfigData.general.recents, layout: false, config: config, error: 'Error saving config: ' + error, user: req.session.user });
	}; //file written


}); // post /config end

router.get('/shows', spxAuth.CheckLogin, async (req, res) => {
	// show list of shows (folders)
	const folderListAsJSON = await spx.GetSubfolders(config.general.dataroot);
	let recents = config.general.recents || [] // added in 1.1.0
	let disableConfigUI = config.general.disableConfigUI || false // added in 1.1.1
	res.render('view-shows', {
		layout: false,
		folders: folderListAsJSON,
		errorMsg: '',
		user: req.session.user,
		recents: recents,
		config: config,
		disableConfigUI: disableConfigUI
	});
}); // get /shows end

router.get('/show/:foldername', spxAuth.CheckLogin, async (req, res) => {
	// Show episodes (files in folder 'data')
	const fileListAsJSON = await spx.GetDataFiles(config.general.dataroot + "/" + req.params.foldername + "/data/");
	let recents = config.general.recents || [] // added in 1.1.0
	let disableConfigUI = config.general.disableConfigUI || false // added in 1.1.1
	let datafile = path.join(
		config.general.dataroot,
		req.params.foldername,
		'profile.json',
	);

	const fileDataAsJSON = await GetJsonData(datafile);
	res.render('view-episodes', {
		layout: false,
		files: fileListAsJSON,
		folder: req.params.foldername,
		errorMsg: '',
		user: req.session.user,
		recents: recents,
		config: config,
		showconfig: fileDataAsJSON,
		disableConfigUI: disableConfigUI
	});
}); // get /show/:foldername end

router.get(
	'/show/:foldername/config',
	spxAuth.CheckLogin,
	async (req, res) => {
		//  Show Configuration
		let datafile = path.join(
			config.general.dataroot,
			req.params.foldername,
			'profile.json',
		);
		const fileDataAsJSON = await GetJsonData(datafile);
		let disableConfigUI = config.general.disableConfigUI || false; // added in 1.1.1

		// a "previous folder" functionality
		let treeData = '';
		let templateRootPath = path.join(
			spx.getStartUpFolder(),
			'ASSETS',
			'templates',
		);
		if (LastBrowsedTemplateFolder == '') {
			treeData = JSON.stringify(spx.GetFilesAndFolders(templateRootPath));
		} else {
			treeData = JSON.stringify(
				spx.GetFilesAndFolders(LastBrowsedTemplateFolder),
			);
		}
		let recents = config.general.recents || []; // added in 1.1.0
		let ERRCODE = '';
		if (req.query.ERR) {
			ERRCODE = 'error.' + req.query.ERR;
		}
		res.render('view-showconfig', {
			layout: false,
			TemplateFiles: treeData,
			TemplateRootFolder: templateRootPath,
			showconfig: fileDataAsJSON,
			folder: req.params.foldername,
			messageCode: '',
			errorCode: ERRCODE,
			user: req.session.user,
			recents: recents,
			config: config,
			disableConfigUI: disableConfigUI,
		});
	},
); // get /show/:foldername/config end

router.post('/show/:foldername/config/removeTemplate', spxAuth.CheckLogin, async (req, res) => {
	//  Remove template index (0 based)
	logger.verbose('Removing template from profile ' + req.body.showFolder);
	let showFolder = req.body.showFolder || "";
	let TemplateIdx = req.body.TemplIndex || 0;
	let ProfileFile = path.join(config.general.dataroot, showFolder, 'profile.json');
	let profileData = await GetJsonData(ProfileFile);
	let templateRef = profileData.templates[TemplateIdx].relpath;
	profileData.templates.splice(TemplateIdx, 1);

	// Then remove references from the users-arrays of each variables
	if (profileData.variables && profileData.variables.length > 0) {
		profileData.variables.forEach(function (variable) {
			var filtered = variable.users.filter(function (value, index, arr) {
				return value != templateRef;
			});
			variable.users = filtered;
		});
	}

	try {
		await spx.writeFile(ProfileFile, profileData);
		res.redirect('/show/' + showFolder + '/config')
	} catch (error) {
		logger.error('removeTemplate Error while saving file: ' + error);
		// console.log('removeTemplate Error while saving file: ', error);
	}; //file written
}); // removeTemplate end

router.post('/show/:foldername/config/removeExtra', spxAuth.CheckLogin, async (req, res) => {
	//  Remove extra index (0 based)
	logger.verbose('Removing extra from profile ' + req.body.showFolder);
	let showFolder = req.body.showFolder || "";
	let ExtraIndex = req.body.ExtraIndex || 0;
	let ProfileFile = path.join(config.general.dataroot, showFolder, 'profile.json');
	let profileData = await GetJsonData(ProfileFile);
	profileData.showExtras.CustomControls.splice(ExtraIndex, 1);
	// spx.talk('Remving extra.');
	try {
		await spx.writeFile(ProfileFile, profileData);
		res.redirect('/show/' + showFolder + '/config')
	} catch (error) {
		logger.error('removeExtra Error while saving file: ' + error);
	}; //file written
}); // removeExtra end

router.post('/show/:foldername/config/saveExtra', spxAuth.CheckLogin, async (req, res) => {
	//  Save extra index (0 based)
	// Executes when Save (in show / extra button) is clicked

	logger.verbose('Overwriting an extra settings in profile ' + req.body.showFolder + ' with updated values.');
	let showFolder = req.body.showFolder || "";
	let ExtraIndex = req.body.ExtraIndex || 0;
	let ProfileFile = path.join(config.general.dataroot, showFolder, 'profile.json');
	let profileData = await GetJsonData(ProfileFile);
	profileData.showExtras.CustomControls[ExtraIndex] = req.body.extraData; // replace an item in array

	if (req.body.newTXT && req.body.newVAL) {
		// new option was added
		var obj = {};
		obj["text"] = req.body.newTXT;
		obj["value"] = req.body.newVAL;
		if (profileData.showExtras.CustomControls[ExtraIndex].items) {
			profileData.showExtras.CustomControls[ExtraIndex].items.push(obj);
		}
		else {
			profileData.showExtras.CustomControls[ExtraIndex].items = [obj];
		}
	}

	// check if some needs to be removed
	let KillItems = []; // a list of items to delete from server array
	if (profileData.showExtras.CustomControls[ExtraIndex].items) {
		profileData.showExtras.CustomControls[ExtraIndex].items.forEach((element, i) => {
			if (element.text == "" || element.value == "") {
				KillItems.push(i);
			}
		});
		KillItems.forEach((item) => {
			profileData.showExtras.CustomControls[ExtraIndex].items.splice(item, 1);
		});
	}


	try {
		await spx.writeFile(ProfileFile, profileData);
		res.redirect('/show/' + showFolder + '/config')
	} catch (error) {
		logger.error('saveExtra Error while saving file: ' + error);
	}; //file written
}); // saveExtra end

router.post(
	'/show/:foldername/config/saveTemplate',
	spxAuth.CheckLogin,
	async (req, res) => {
		// Save template index (0 based)
		// This runs when template is modified in show config
		logger.verbose(
			'Overwriting a template in profile ' +
			req.body.showFolder +
			' with updated values.',
		);
		let showFolder = req.body.showFolder || '';
		let TemplateIdx = req.body.TemplIndex || 0;
		let ProfileFile = path.join(
			config.general.dataroot,
			showFolder,
			'profile.json',
		);
		let profileData = await GetJsonData(ProfileFile);

		// Save steps as otherwise they disappear when template is saved
		let steps;
		if (profileData.templates[TemplateIdx].steps) {
			steps = profileData.templates[TemplateIdx].steps;
		}

		let newData = req.body.templateData || {};

		if (profileData.projectFormat === 'OGRAF') {
			let ografProps =
				profileData.templates[TemplateIdx].ografProps || {};
			newData.ografProps = ografProps;
		}

		profileData.templates[TemplateIdx] = newData; // replace an item in array

		// Save steps to new data
		if (steps) {
			profileData.templates[TemplateIdx].steps = steps;
		}

		// get DataFields and replace that
		let DataFieldArray = JSON.parse(
			decodeURI(profileData.templates[TemplateIdx].DataFields),
		);
		profileData.templates[TemplateIdx].DataFields = DataFieldArray;
		// spx.talk('Saving template changes.');
		try {
			await spx.writeFile(ProfileFile, profileData);
			res.redirect('/show/' + showFolder + '/config');
		} catch (error) {
			logger.error('saveTemplate Error while saving file: ' + error);
		} //file written
	},
); // saveTemplate end

router.post('/show/:foldername/config/saveGeneralSettings', spxAuth.CheckLogin, async (req, res) => {
	// Added in 1.0.15
	// Save General Settigs of a project
	// console.log("Profile: " + req.body.showFolder)
	// console.log("Background value: " + req.body.background)
	logger.verbose('Overwriting a profile ' + req.body.showFolder + ' with updated values.');
	let showFolder = req.body.showFolder || "";
	let ProfileFile = path.join(config.general.dataroot, showFolder, 'profile.json');
	let profileData = await GetJsonData(ProfileFile) || {};
	profileData.general = {};
	profileData.general.background = req.body.background;

	io.emit('SPXMessage2Client', {
		spxcmd: 'setRendererBackgroundImage',
		background: req.body.background
	});

	try {
		await spx.writeFile(ProfileFile, profileData);
		res.redirect('/show/' + showFolder + '/config')
	} catch (error) {
		logger.error('saveGeneralSettings Error while saving file: ' + error);
	}; //file written
}); // saveGeneralSettings end

router.post('/show/:foldername/config', spxAuth.CheckLogin, async (req, res) => {
	// a POST handler for adding content to the <show>/profile.json.
	// 
	// Called from templateChooser -modal, for instance.
	// Also here we scan the source file and extract needed fields into the profile.
	// Also handles adding new extras to the show profile.
	//
	// REQUEST .... data with template folder / name and profle folder name
	// RETURNS .... json data with folder and file arrays
	//

	try { // added in 1.1.1
		logger.verbose('Adding new stuff to profile in ' + req.body.showFolder);
		let curFolder = req.body.curFolder || "";
		let template = req.body.template || "";
		let showFolder = req.body.showFolder || "";
		let command = req.body.command || "";
		let ftype = req.body.ftype || "";
		let customscript = req.body.customscript || "";
		let TemplatePath = path.join(curFolder, template).trim();
		let ProfileFile = path.join(config.general.dataroot, showFolder, 'profile.json');
		let profileData = await GetJsonData(ProfileFile) || {}; // or empty
		let replaceIndex = req.body.replaceIndex || ""; // v.1.0.11 replace existing, a reimport

		switch (command) {

			case 'addtemplates':
				// Added in 1.1.4
				// ADD SEVERAL TEMPLATES AT ONCE
				let templates = JSON.parse(req.body.templates || []);
				templates.forEach((template, index) => {
					TemplatePath = path.join(curFolder, template).trim();
					profileData = addTemplateToProfile(profileData, TemplatePath, showFolder, curFolder, replaceIndex)
				});
				break;

			case 'addtemplate':
				// ADD (or RE-IMPORT) A TEMPLATE
				profileData = addTemplateToProfile(profileData, TemplatePath, showFolder, curFolder, replaceIndex)
				if (profileData.error) {
					res.redirect('/show/' + showFolder + '/config?ERR=templateDefinitionMissing')
				}
				break;

			case 'addshowextra':
				// ------------------------------------- ADDING EXTRA -----------------
				let newExtra = {};
				switch (ftype) {
					case 'button':
						newExtra.description = 'A new push button';
						newExtra.ftype = 'button';
						newExtra.bgclass = 'bg_blue';
						newExtra.text = 'Hello world';
						newExtra.fcall = "demo_popup('Hello world!')";
						break;

					case 'togglebutton':
						newExtra.description = 'A new toggle button';
						newExtra.ftype = 'togglebutton';
						newExtra.bgclass = 'bg_blue';
						newExtra.text0 = 'START ME';
						newExtra.text1 = 'STOP ME';
						newExtra.fcall = 'demo_toggle(this)';
						break;

					case 'selectbutton':
						newExtra.description = 'Selectbutton demo';
						newExtra.ftype = 'selectbutton';
						newExtra.bgclass = 'bg_blue';
						newExtra.text = 'Play';
						newExtra.fcall = 'playSelectedAudio';
						newExtra.value = 'media/wav/applause.wav';
						newExtra.items = [];
						let option0 = {};
						option0.text = 'Applause';
						option0.value = 'media/wav/applause.wav';
						newExtra.items.push(option0);
						let option1 = {};
						option1.text = 'No!';
						option1.value = 'media/wav/no.wav';
						newExtra.items.push(option1);
						let option2 = {};
						option2.text = 'Yesss!';
						option2.value = 'media/wav/yes.wav';
						newExtra.items.push(option2);
						break;

					default:
						logger.warn('Warning: Extra type ' + ftype + ' is unknown. Adding nothing to the profile-file.');
						break;
				}
				if (!profileData.showExtras) {
					// lets add a showExtras section to profile
					profileData.showExtras = {};
					profileData.showExtras.CustomControls = [];
				}
				profileData.showExtras.CustomControls.push(newExtra);
				break;

			case 'addshowextrascript':
				// ------------------------------- ADDING SHOW EXTRA SCRIPT -----------------
				if (!profileData.showExtras) {
					// lets add a showExtras section to profile
					profileData.showExtras = {};
					profileData.showExtras.CustomControls = [];
				}
				profileData.showExtras.customscript = customscript;
				break;

			default:
				// --------------------------- UNKNOWN COMMAND -----------------
				logger.warn('Warning: Command ' + command + ' is unknown. Adding nothing to the profile-file.');
				break;
		}

		// await spx.writeFile(ProfileFile,profileData);
		await spx.writeFile(ProfileFile, profileData)
			.then(
				res.redirect('/show/' + showFolder + '/config')
			)
			.catch(function (error) {
				console.log('\nEnd of template import errors.', error)
				// res.redirect('/show/' + showFolder + '/config')
			})
	} catch (error) {
		logger.error('showconfig / ' + error);
		// res.redirect('/show/' + showFolder + '/config')
	}; //file written

}); // browseTemplates API post request end


router.post('/shows/', spxAuth.CheckLogin, async (req, res) => {
	// add a new showfolder (with /data -subfolder) and open it for configuration
	let targetFolder = path.join(config.general.dataroot, req.body.foldername);
	let targetDataFo = path.join(config.general.dataroot, req.body.foldername, "data");
	let folderListAsJSON = ""
	if (fs.existsSync(targetFolder)) {
		folderListAsJSON = await spx.GetSubfolders(config.general.dataroot);
		res.render('view-shows', { layout: false, folders: folderListAsJSON, error: 'Folder exists, try again with another name.', user: req.session.user });
	}
	else {
		fs.mkdirSync(targetFolder);
		fs.mkdirSync(targetDataFo);

		// save a new empty profile.json
		let profileFile = {};
		profileFile.projectFormat = req.body.format.toUpperCase() || 'SPX';
		let profileFilePath = path.join(targetFolder, 'profile.json');
		await spx.writeFile(profileFilePath, profileFile);

		res.redirect('/show/' + req.body.foldername + '/config');
	}
}); // post /shows/ end


router.post('/show/:foldername', spxAuth.CheckLogin, async (req, res) => {
	// add a new json file and open it for editing
	let datafile = path.join(config.general.dataroot + '/' + req.params.foldername + '/data/' + req.body.filebasename) + '.json';
	logger.verbose('Creating file', datafile);

	// check if exist
	if (fs.existsSync(datafile)) {
		//file exists
		logger.warn('Episode file exists [' + datafile + '], going back to episode list.');
		const fileListAsJSON = await spx.GetDataFiles(config.general.dataroot + "/" + req.params.foldername + "/data/");
		res.render('view-episodes', { layout: false, files: fileListAsJSON, folder: req.params.foldername, error: 'File exists, use another name.', user: req.session.user });
	}
	else {
		// file was not there
		// spx.talk('Adding a new empty rundown file...');
		try {
			let EmptyJSON = {};
			await spx.writeFile(datafile, EmptyJSON);
			res.redirect('/gc/' + req.params.foldername + '/' + req.body.filebasename);
		} catch (error) {
			logger.error('Error while creating file: ' + error);
		}; //file written
	}
}); // post /show/:foldername end


router.delete('/show/:folder/:file', spxAuth.CheckLogin, async (req, res) => {
	res.send("would delete file " + req.params.folder + "/data/" + req.params.file + ".json");
	let datatemp = path.join(config.general.dataroot, req.params.folder, "data", req.params.file) + '.json';
	let datafile = path.normalize(datatemp);
	fs.unlink(datafile, function (err) {
		if (err) {
			logger.error('Error while deleting ' + datafile + ': ' + err)
			// res.send(err);
		}
		else {
			logger.verbose('Deleted file: ' + datafile);
			rundownStore.remove(datafile);
			// client will reload in 500ms
		}
	});
}); // delete /show/:folder/:file end


router.delete('/shows/:foldername', spxAuth.CheckLogin, async (req, res) => {
	// delete a showfolder (an Ajax call, therefor the redirect does not work, must do from client side.)
	let datafolder = path.join(config.general.dataroot, req.params.foldername);
	const deleteFolderRecursive = function (datafolder) {
		if (fs.existsSync(datafolder)) {
			fs.readdirSync(datafolder).forEach((file, index) => {
				const curPath = path.join(datafolder, file);
				logger.debug('Deleting ' + curPath);

				if (fs.lstatSync(curPath).isDirectory()) { // recurse
					deleteFolderRecursive(curPath);
				} else { // delete file
					logger.verbose('Deleted file: ' + curPath);
					fs.unlinkSync(curPath);
				}
			});
			logger.debug('Deleting folder ' + datafolder);
			fs.rmdirSync(datafolder);
		}
		else {
			logger.warn('Folder ' + datafolder + ' did not exist, cannot delete.');
		}
	}

	try {
		deleteFolderRecursive(datafolder);
		logger.verbose('Deleted folder: ' + datafolder);
	}
	catch (error) {
		logger.error('Error while deleting ' + datafolder + ': ' + error)
		res.send(error);
	}
	const folderListAsJSON = await spx.GetSubfolders(config.general.dataroot);
	res.render('view-shows', { layout: false, folders: folderListAsJSON, errorMsg: '', user: req.session.user });

}); // delete /shows/:foldername end


router.get('/gc/:foldername/:filename/:mode?', spxAuth.CheckLogin, async (req, res) => {
	// G R A P H I C   C O N T R O L L E R   M A I N   V I E W
	let datafile = path.join(config.general.dataroot, req.params.foldername, 'data', req.params.filename) + '.json';

	let [easterImg, easterTxt] = spx.getEasterEggImage();

	const fileDataAsJSON = await spx.RemoveFilepathKey(GetJsonData(datafile));


	if (fileDataAsJSON?.ografs) {
		fileDataAsJSON.templates = fileDataAsJSON.ografs;
		fileDataAsJSON.ografs = null
		fileDataAsJSON.projectFormat = "OGRAF"
	}
	// fileDataAsJSON = spx.RemoveFilepathKey(fileDataAsJSON); // Added in 1.3.0

	fileDataAsJSON.project = req.params.foldername; // Added in 1.3.2
	fileDataAsJSON.rundown = req.params.filename; // Added in 1.3.2
	// Please note, these does not show in the rundownfile itself,
	// but is used in the controller view and is in memory only for now.
	// Only when something is changed (or played), it will be written to the file.

	// Opening a rundown reloads it from disk into the store and makes it the
	// controller's current rundown.
	if (fileDataAsJSON && typeof fileDataAsJSON === 'object') {
		rundownStore.set(datafile, fileDataAsJSON);
		rundownStore.setCurrent(datafile);
	}

	let showprofile = path.join(config.general.dataroot, req.params.foldername, 'profile.json');
	const profileDataJSONobj = await GetJsonData(showprofile);
	let profileData = JSON.stringify(profileDataJSONobj);
	let projectBackground = '';

	if (profileDataJSONobj && profileDataJSONobj.general && profileDataJSONobj.general.background) {
		projectBackground = profileDataJSONobj.general.background;
	}

	// list of CSV files
	// TODO:
	let csvFileList = '';
	csvFileList = JSON.stringify(spx.GetFilesAndFolders(path.resolve(spx.getStartUpFolder(), 'ASSETS', 'csv'), 'csv'));

	// Added in 1.3.0
	let outputSize = getResolutionFromConfig(global.config, req.query);

	let recents = config.general.recents || [] // added in 1.1.0
	let preview = config.general.preview || 'none' // added in 1.1.0
	let rnrtype = config.general.renderer || 'normal'  // added in 1.1.0
	let assetsFolder = path.resolve(spx.getStartUpFolder(), 'ASSETS') || '' // added in 1.1.0
	let disableConfigUI = config.general.disableConfigUI || false // added in 1.1.1
	let disableLRenderer = config.general.disableLocalRenderer || false // added in 1.2.0

	function getPageTemplate() {
		// Added in 1.3.0
		if (req.params.mode && req.params.mode.toLowerCase() === 'light') {
			return 'view-controllermini';
		} else {
			return 'view-controller';
		}
	}


	res.render(getPageTemplate(), {
		layout: false,
		globalExtras: config.globalExtras,
		filedata: fileDataAsJSON,
		folder: req.params.foldername,
		datafile: datafile,
		filebasename: req.params.filename,
		profiledata: profileData,
		profiledataObj: profileDataJSONobj,
		user: req.session.user,
		background: projectBackground,
		csvFileList: csvFileList,
		width: outputSize.width,
		height: outputSize.height,
		previewMode: preview,
		recents: recents,
		renderer: rnrtype,
		assetsFolder: assetsFolder,
		disableConfigUI: disableConfigUI,
		disableLRender: disableLRenderer,
		autoplayLocalRenderer: config.general.autoplayLocalRenderer,
		easteregg: easterImg,
		easterText: easterTxt
	});

	let bgImage = ''
	if (profileDataJSONobj && profileDataJSONobj.general && profileDataJSONobj.general.background) {
		bgImage = profileDataJSONobj.general.background
	}

	setTimeout(function () {
		io.emit('SPXMessage2Client', {
			spxcmd: 'setRendererBackgroundImage',
			background: bgImage
		});
	}, 500);
	spx.setRecents(req.params.foldername + '/' + req.params.filename) // Added in 1.1.0
}); // get /gc/:foldername/:filename end


router.post('/gc/:foldername/:filename/', spxAuth.CheckLogin, async (req, res) => {
	//
	// Can handle several commands from the controller page
	//

	let profileDataJSONobj;
	let showprofile = "";
	let data = req.body;
	let filepath;
	switch (data.command) {

		case 'importCSVdata':
			try {
				// CSV IMPORT function. The source CSV must have been exported via the EXPORT function.
				let fieldsFound = false; // check at the end
				logger.verbose('Importing CSV from ' + data.curFolder + '/' + data.importFile + ' to be appended to ' + data.RundownFile);
				let importedItems = [];
				// now get the CSV file and start parsing line-by-line
				let CSVfileData = await GetTextFileData(path.join(data.curFolder, data.importFile))
				// console.log('CSV content', CSVfileData.toString());

				let startSeconds = String(Date.now());

				let csvLines = CSVfileData.split('\n')

				var t_description
				var t_playserver
				var t_playchannel
				var t_playlayer
				var t_webplayout
				var t_out
				var t_uicolor
				var t_onair
				var t_dataformat
				var t_relpath
				var t_graphicPath
				var t_version
				var t_id
				var t_project
				var t_rundown


				let curLineItems = []
				var protoFields = [];
				var protoFtypes = [];
				var protoTitles = [];
				var protoFcalls = [];
				var protoValues = [];
				var dataFiProto = {}; // placeholder obj for fields
				var templateTmp = []; // placeholder arr for objects
				var fieldIndex = 0; // iterate 


				// First we get METADATA (another lines forEach for content afterwards)
				csvLines.forEach((line, lineindex) => {
					if (line.trim() === '') { return; }
					curLineItems = line.split(';')
					// console.log('Line ' + lineindex, curLineItems);
					switch (curLineItems[0].trim()) {
						case '# description #':
							t_description = curLineItems[1].trim();
							break;

						case '# playserver #':
							t_playserver = curLineItems[1].trim();
							break;

						case '# playchannel #':
							t_playchannel = curLineItems[1].trim();
							break;

						case '# playlayer #':
							t_playlayer = curLineItems[1].trim();
							break;

						case '# webplayout #':
							t_webplayout = curLineItems[1].trim();
							break;

						case '# out #':
							t_out = curLineItems[1].trim();
							break;

						case '# uicolor #':
							t_uicolor = curLineItems[1].trim();
							break;

						case '# onair #':
							t_onair = curLineItems[1].trim();
							break;

						case '# dataformat #':
							t_dataformat = curLineItems[1].trim();
							break;

						case '# relpath #':
							t_relpath = curLineItems[1].trim();
							break;

						case '# graphicPath #':
							t_graphicPath = curLineItems[1].trim();
							break;

						case '# version #':
							t_version = curLineItems[1].trim();
							break;

						case '# id #':
							t_id = curLineItems[1].trim();
							break;

						case '# project #':
							t_project = curLineItems[1].trim();
							break;

						case '# rundown #':
							t_rundown = curLineItems[1].trim();
							break;


						case '# FieldUUIDs #':
							// this line carries f-field ids (f0, f1, etc)
							// and will generate required objects
							fieldsFound = true;
							for (let uuidindex = 1; uuidindex < curLineItems.length - 1; uuidindex++) {
								protoFields.push(curLineItems[uuidindex].trim());
							}
							break;

						case '# FieldTypes #':
							for (let typeindex = 1; typeindex < curLineItems.length - 1; typeindex++) {
								let thisFieldType = curLineItems[typeindex].trim()
								protoFtypes.push(thisFieldType)
							}
							break;

						case '# FieldTitls #':
							for (let titindex = 1; titindex < curLineItems.length - 1; titindex++) {
								protoTitles.push(curLineItems[titindex].trim())
							}
							break;

						case '# Fieldfcalls #':
							for (let fcallsindex = 1; fcallsindex < curLineItems.length - 1; fcallsindex++) {
								protoFcalls.push(curLineItems[fcallsindex].trim())
							}
					} // switch line type
				}); // for each line METADATA done


				// Then iterate all CONTENT LINES and append template to OBJ array
				var templateData
				csvLines.forEach((line, loopIndex) => {
					if (line.trim() === '') { return; } // empty line
					curLineItems = line.split(';')
					templateData = {}
					templateData.DataFields = []

					if (line.startsWith('# ID:')) {

						fieldIndex++; // template counter for GUI message

						for (let index = 1; index < curLineItems.length - 1; index++) {
							protoValues.push(curLineItems[index].trim())
						}

						// generate ID
						if (line.startsWith('# ID:auto')) {
							// generate EPOCH
							templateData.itemID = startSeconds + loopIndex
						} else {
							// use the given value
							templateData.itemID = curLineItems[0].trim().replace('# ID:', '').trim()
						}

						templateData.description = t_description
						templateData.playserver = t_playserver
						templateData.playchannel = t_playchannel
						templateData.playlayer = t_playlayer
						templateData.webplayout = t_webplayout
						templateData.out = t_out
						templateData.uicolor = t_uicolor
						templateData.onair = t_onair
						templateData.dataformat = t_dataformat
						templateData.relpath = t_relpath
						// If ograf, then add ograf properties
						if (t_graphicPath && t_version && t_id) {
							templateData.ografProps = {}
							templateData.ografProps.graphicPath = t_graphicPath
							templateData.ografProps.version = t_version
							templateData.ografProps.id = t_id
						}

						// Append warning
						templateData.DataFields.push({
							ftype: "instruction",
							value: "⚠ WARNING: This item was generated with CSV import and typically is not intended for manual editing. Please use the original template for manual input."
						});

						// Then iterate all fields and assing values
						for (let i = 0; i < protoFields.length; i++) {
							dataFiProto = {}
							dataFiProto.field = protoFields[i]
							if (protoFtypes[i] == 'textarea') {
								dataFiProto.ftype = 'textarea'  // for multiline texts
							} else if (protoFtypes[i] == 'button') {
								dataFiProto.ftype = 'button'
								dataFiProto.fcall = protoFcalls[i]
							} else if (protoFtypes[i] == 'checkbox')
								dataFiProto.ftype = 'checkbox'
							else {
								dataFiProto.ftype = 'textfield' // protoFtypes[i] !forced!
							}
							// dataFiProto.ftype = "textfield" // protoFtypes[i] !forced!
							dataFiProto.title = protoTitles[i]
							if (curLineItems[i + 1].length > 0) {
								dataFiProto.value = curLineItems[i + 1].replace(/<BR>/g, '\n') // add newlines back
							}
							templateData.DataFields.push(dataFiProto);
						}
						importedItems.push(templateData)
					} // content line process ended 
				});

				// saving new items to the rundown (memory and disk)
				const saved = await rundownStore.update(data.RundownFile, (rundown) => {
					spx.RemoveFilepathKey(rundown);
					rundown.templates = (rundown.templates || []).concat(importedItems);
					spx.appendProjectFile(rundown, data.RundownFile);
				});
				if (!saved) {
					throw 'Rundown file not found: ' + data.RundownFile;
				}
				if (fieldsFound) {
					res.redirect('/gc/' + data.foldername + '/' + data.filebasename + '?msg=Added ' + fieldIndex + ' templates.');
					break;
				} else {
					res.redirect('/gc/' + data.foldername + '/' + data.filebasename + '?msg=invalidCSV');
				}
			} catch (error) {
				logger.error('importCSVdata Error: ' + error);
				res.status(500).send('CSV import failed: ' + error);
			}

			break;

		case 'addAllItemsToRundown':
			// ADD ALL TEMPLATES TO RUNDOWN /// Added in 1.2.0
			try {
				logger.verbose('Adding all show profile templates to rundown ' + data.listname);
				showprofile = path.join(config.general.dataroot, data.foldername, 'profile.json');
				profileDataJSONobj = await GetJsonData(showprofile);
				let ProfileTemplatesArray = profileDataJSONobj.templates || [];

				ProfileTemplatesArray.forEach((template, index) => {
					template.itemID = String(Date.now() + index); // generate EPOCH for each template
				});

				const saved = await rundownStore.update(data.datafile, (rundown) => {
					rundown.projectFormat = profileDataJSONobj.projectFormat;
					rundown.templates = (rundown.templates || []).concat(ProfileTemplatesArray);
				});
				if (!saved) {
					throw 'Rundown file not found: ' + data.datafile;
				}
				res.redirect('/gc/' + data.foldername + '/' + data.listname);
				return;
			} catch (error) {
				logger.error('addAllItemsToRundown Error while saving file: ' + error);
				res.status(500).send('Could not add items: ' + error);
			}; //file written
			break;

		case 'addItemToRundown':
			// ADD TEMPLATE ITEM TO RUNDOWN ///////
			try {
				logger.verbose('Adding show profile template[' + data.templateindex + '] to rundown ' + data.listname);
				showprofile = path.join(config.general.dataroot, data.foldername, 'profile.json');
				profileDataJSONobj = await GetJsonData(showprofile);
				let TemplateModel = profileDataJSONobj.templates[data.templateindex];
				TemplateModel.itemID = String(Date.now());  // Generate ID (epoch milliseconds) for this rundown item (from v. 0.9.8 onwards)
				// This will be used to control UI (play, remove, sort, etc...)
				const saved = await rundownStore.update(data.datafile, (rundown) => {
					rundown.templates = rundown.templates || [];
					rundown.templates.push(TemplateModel);
					rundown.projectFormat = profileDataJSONobj.projectFormat;
				});
				if (!saved) {
					throw 'Rundown file not found: ' + data.datafile;
				}
				res.redirect('/gc/' + data.foldername + '/' + data.listname);
				return;
			} catch (error) {
				logger.error('addItemToRundown Error while saving file: ' + error);
				res.status(500).send('Could not add item: ' + error);
			}; //file written
			break;

		case 'removeItemFromRundown':
			// REMOVE TEMPLATE ITEM FROM RUNDOWN (without reloading page) ///////////////////////////////////////////////////////////////////////////
			logger.verbose('Removing template epoch [' + data.epoch + '] from rundown ' + data.listname);
			try {
				const saved = await rundownStore.update(data.datafile, (rundown) => {
					spx.RemoveFilepathKey(rundown); // Added in 1.3.0
					const templateIndex = (rundown.templates || []).findIndex((template) => template.itemID == data.epoch);
					if (templateIndex > -1) {
						rundown.templates.splice(templateIndex, 1);
					}
					spx.appendProjectFile(rundown, data.datafile, "from gc/removeItemFromRundown");
				});
				if (!saved) {
					throw 'Rundown file not found: ' + data.datafile;
				}
				res.status(200).send('Item removed ok.'); // ok 200 AJAX RESPONSE
			} catch (error) {
				logger.error('removeItemFromRundown Error while saving file: ' + error);
				res.status(500).send('Could not remove item: ' + error);
			}; //file written
			break;

		case 'duplicateRundownItem':
			// CLONE TEMPLATE ITEM ON RUNDOWN (without reloading page) ///////////////////////////////////////////////////////////////////////////

			logger.verbose('Cloning item [' + data.sourceEpoch + '] to [' + data.cloneEpoch + '] in file [' + data.listname + '].');
			try {
				const saved = await rundownStore.update(data.datafile, (rundown) => {
					const sourceIndex = (rundown.templates || []).findIndex((template) => template.itemID == data.sourceEpoch);
					if (sourceIndex === -1) {
						return false; // nothing to save
					}
					const copy = JSON.parse(JSON.stringify(rundown.templates[sourceIndex]));
					copy.itemID = data.cloneEpoch;
					copy.onair = 'false';
					rundown.templates.splice(sourceIndex + 1, 0, copy);
				});
				if (!saved) {
					throw 'Rundown file not found: ' + data.datafile;
				}
				res.status(200).send('Item duplicated ok.'); // ok 200 AJAX RESPONSE
			} catch (error) {
				logger.error('duplicateRundownItem Error while saving file: ' + error);
				res.status(500).send('Could not duplicate item: ' + error);
			}; //file written
			break;

		case 'saveRundownItemModifications':
			// SAVE CHANGES MADE TO A SINGLE RUNDOWN ITEM /////////////////////////////////////////////////////////////////////////////////////////
			// Not in use, see --> /gc/saveItemChanges
			break;

		default:
			logger.warn('Warning: unknown gc-post command: ' + data.command);
			break;
	}
}); // gc post end


router.post('/gc/playout', spxAuth.CheckLogin, async (req, res) => {
	const result = await playoutService.playout(req.body);
	res.status(result.status).send(result.body);
});


router.post('/gc/playaudio', spxAuth.CheckLogin, (req, res) => {
	// handle incoming sound fx requests
	// TODO: Enable this playaudio ajax call for template based audio triggers!
	try {
		logger.info('gc/playaudio ' + req.body.sound + ', ' + req.body.info, null, 4);
		spx.playAudio(req.body.sound, req.body.info);
		res.status(200).send('Playaudio command processed.'); // ok 200 AJAX RESPONSE
	} catch (error) {
		logger.error('ERROR, unable to send playaudio command. Server up? ' + error)
		res.status(500).send('Server error in /gc/playaudio [' + error + '].')  // error 500 AJAX RESPONSE
	}
}); // playaudio ended


router.post('/gc/controlvideo', spxAuth.CheckLogin, async (req, res) => {
	try {
		// handle video commands
		logger.debug('Forwarding command to PlayoutCCG.VideoPlayerController');
		PlayoutCCG.VideoPlayerController(req.body);
		res.status(200).send('All ok'); // ok 200 AJAX RESPONSE
	} catch (error) {
		logger.error('Server error in /gc/controlvideo. Server up? ' + error)
		res.status(500).send('Server error in /gc/controlvideo: ' + error);  // error 500 AJAX RESPONSE
	}
}); // control ended


router.post('/gc/clearPlayouts', spxAuth.CheckLogin, async (req, res) => {
	// Slightly improved in v.1.0.12
	try {
		logger.verbose('Clearing all layers');
		res.status(200).send('Graphics clear requests sent')  // ok 200 AJAX RESPONSE

		// Clear Webplayout ---------------------------
		io.emit('SPXMessage2Client', { spxcmd: 'clearAllLayers' }); // clear webrenderers
		io.emit('SPXMessage2Controller', { APIcmd: 'RundownAllStatesToStopped' }); // stop UI and save stopped values to rundown

		// Change all items to offair on the playlist file
		if (req.body.datafile) {
			await rundownStore.update(path.normalize(req.body.datafile), (rundown) => {
				(rundown.templates || []).forEach((item) => {
					item.onair = "false"
				});
				rundown.updated = new Date().toISOString();
			});
		}

		// Clear CasparCG -------------------
		if (!spx.CCGServersConfigured()) { return } // exit early, no need to do any CasparCG work
		PlayoutCCG.clearChannelsFromGCServer(req.body.server) // server is optional
	}
	catch (error) {
		logger.error('Error in gc/clearPlayouts while clearing channels. [' + error + '].');
		if (!res.headersSent) res.status(500).send('SPX error in gc/clearPlayouts [' + error + '].')  // error 500 AJAX RESPONSE
	};

}); // clearPlayouts ended


router.post('/gc/sortTemplates', spxAuth.CheckLogin, async (req, res) => {
	// Handles modification changes of a template in the rundown.
	// Request: data with newTemplateOrderArr -array (of epochs)
	// Returns: AJAX response
	logger.verbose('Sorting templates in ' + req.body.rundownfile + ' to ' + req.body.newTemplateOrderArr);
	try {
		const saved = await rundownStore.update(path.normalize(req.body.rundownfile), (rundown) => {
			let TempArr = [];
			req.body.newTemplateOrderArr.forEach(function (sortedID) {
				rundown.templates.forEach(function (template, templateIndex) {
					if (template.itemID === sortedID) {
						logger.debug("Sorting. Saving to position " + templateIndex + " itemID " + sortedID);
						TempArr.push(template);
					}
				})
			});
			rundown.templates = TempArr;
			rundown.updated = new Date().toISOString();
		});
		if (!saved) {
			throw 'Rundown file not found: ' + req.body.rundownfile;
		}
		res.status(200).send('Rundown sorting saved.'); // ok 200 AJAX RESPONSE
	}
	catch (error) {
		logger.error('Error in /gc/sortTemplates while sorting data. [' + error + '].');
		res.status(500).send('Server error in /gc/sortTemplates [' + error + '].')  // error 500 AJAX RESPONSE
	};
}); // sortTemplates ended


router.post('/gc/duplicateRundown', spxAuth.CheckLogin, async (req, res) => {
	// Create a duplicate 
	// Request: data obj
	let foldname = req.body.foldname;
	let filename = req.body.filename;
	let filerefe = path.normalize(path.join(config.general.dataroot, foldname, 'data', filename));
	try {
		await spx.duplicateFile(filerefe, ' copy');
		res.status(200).send('Item duplicated.'); // ok 200 AJAX RESPONSE
	} catch (error) {
		let errmsg = 'Server error in /gc/duplicateRundown [' + error + ']';
		logger.error(errmsg);
		res.status(500).send(errmsg)  // error 500 AJAX RESPONSE   
	}
}); // duplicateRundown ended


router.post('/gc/renameRundown', spxAuth.CheckLogin, async (req, res) => {
	// Rename a rundown file
	// Request: data obj
	let foldnam = req.body.foldnam;
	let orgname = req.body.orgname;
	let newname = req.body.newname;
	let fileref = path.normalize(path.join(config.general.dataroot, foldnam, 'data', orgname));
	try {
		await spx.renameRundown(fileref, newname);
		rundownStore.remove(fileref);
		res.status(200).send('Item renamed.'); // ok 200 AJAX RESPONSE
	} catch (error) {
		let errmsg = 'Server error in /gc/renameRundown [' + error + ']';
		logger.error(errmsg);
		res.status(500).send(errmsg)  // error 500 AJAX RESPONSE   
	}
}); // renameRundown ended


router.post('/gc/saveConfigChanges', spxAuth.CheckLogin, async (req, res) => {
	// Added in 1.1.0. Handles modification changes of given config items.
	// Request: key / val pair as a data object.
	// Returns: Ajax response

	logger.verbose('Overwriting config with updated values.');
	try {
		var ConfigFile = global.configfileref;
		var ConfigData = await GetJsonData(ConfigFile);

		let key = req.body.key || null;
		let val = req.body.val;

		// Fixed in v1.3.0 (check truthiness)
		if (key == null || val == null || val == undefined) {
			throw 'Key [' + key + '] or a supported value [' + val + '] was missing from request, skipping config save.';
		}

		ConfigData.general[key] = val;
		global.config = ConfigData; // update mem version also
		await spx.writeFile(ConfigFile, ConfigData);
		let response = ['Config changed']
		res.status(200).send(response); // ok 200 AJAX RESPONSE
	} catch (error) {
		console.error('ERROR', error);
		let errmsg = 'Server error in /gc/saveConfigChanges [' + error + ']';
		logger.error(errmsg);
		res.status(500).send(errmsg)  // error 500 AJAX RESPONSE
	};
}); // saveConfigChanges ended


router.post('/gc/saveItemChanges', spxAuth.CheckLogin, async (req, res) => {
	// Handles modification changes of a template in the rundown.
	// Request: form data as JSON
	// Returns: Ajax response
	logger.verbose('Overwriting a template itemID [' + req.body.epoch + '] in rundown [' + req.body.rundownfile + '] with updated values.');
	try {
		// spx.talk('Saving template changes from rundown.');
		var DataFieldsForCollapsePreview;
		const saved = await rundownStore.update(path.normalize(req.body.rundownfile), (rundown) => {
			spx.RemoveFilepathKey(rundown); // Added in 1.3.0
			rundown.templates.forEach((template) => {
				if (template.itemID == req.body.epoch) {
					req.body.DataFields.forEach(function (PostField) {
						template.DataFields.forEach(function (JsonField) {
							if (PostField.field == JsonField.field) {
								JsonField.value = PostField.value;
							}
						});
						DataFieldsForCollapsePreview = template.DataFields;
					});
				}
			});
		});
		if (!saved) {
			throw 'Rundown file not found: ' + req.body.rundownfile;
		}
		var htmlSnippetForCollapse = spx.generateCollapsedHeadline(DataFieldsForCollapsePreview);
		let response = ['Item changes saved', htmlSnippetForCollapse]
		res.status(200).send(response); // ok 200 AJAX RESPONSE
	} catch (error) {
		console.error('ERROR', error);
		let errmsg = 'Server error in /gc/saveItemChanges [' + error + ']';
		logger.error(errmsg);
		res.status(500).send(errmsg)  // error 500 AJAX RESPONSE
	};
}); // saveItemChanges ended




// FUNCTIONS --------------------------------------------------------------------------------------------------

// This functions is OGraf specific and handles ograf templates.
function addOgrafTemplateToProfile(profileData, TemplatePath, showFolder, curFolder, replaceIndex = null) {
	// console.log("addOgrafTemplateToProfile called with TemplatePath:", TemplatePath);
	if (replaceIndex) {
		// when replacing, the path does not come with absolute path, must append
		TemplatePath = path.join(spx.getStartUpFolder(), 'ASSETS', 'templates', TemplatePath)
		global.LastBrowsedTemplateFolder = path.join(spx.getStartUpFolder(), 'ASSETS', 'templates', curFolder); // Bugfix added in 1.1.1
	} else {
		// we are adding (not re-importing) so this works
		global.LastBrowsedTemplateFolder = curFolder;
	}

	let rawJson = fs.readFileSync(TemplatePath, 'utf8');
	let ografJson = JSON.parse(rawJson);


	// Convert schema.properties to DataFields
	const properties = ografJson.schema?.properties || {};
	const DataFields = Object.entries(properties).map(([key, prop]) => {
		let ftype = null;

		let dataProps = {
			field: key,
			ftype: 'textfield', // default type
			value: prop.default || '',
			title: prop.title || key
		}

		if (prop.v_spx) {
			// SPX VENDOR TYPES
			dataProps.ftype = prop.v_spx.ftype;

			switch (dataProps.ftype.toLowerCase()) {
				case 'instruction':
					break;

				case 'dropdown':
					dataProps.items = prop.v_spx.items || [];
					break;

				case 'textarea':
					break;

				case 'divider':
					break;

				case 'filelist':
					dataProps.assetfolder = prop.v_spx.assetfolder || '/media/images/';
					dataProps.extension = prop.v_spx.extension || 'png';
					break;

				case 'number':
					break;

				case 'checkbox':
					break;

				case 'button':
					dataProps.fcall = prop.v_spx.fcall;
					break;

				case 'spacer':
					break;

				case 'color':
					break;

				case 'plugin':
					dataProps.plugin = prop.v_spx.fcall || 'UnknownFolder';
					dataProps.title = prop.v_spx.title || 'Extension';
					dataProps.descr = prop.v_spx.descr || 'Info';
					dataProps.value = prop.v_spx.value || 'alert';
					break;
			} // end spx switch
		} else {
			// OGRAF TYPE CONVERSIONS TO SPX
			switch (prop.type.toLowerCase()) {
				case 'boolean':
					dataProps.ftype = 'checkbox';
					dataProps.value = prop.default ? "1" : "0";
					break;

				case 'number':
					dataProps.ftype = 'number';
					break;

				default:
					dataProps.ftype = 'textfield';
			} // end ograf switch
		}

		return dataProps;
	});
	if (ografJson.customActions) {
		let webplayout = ografJson.v_spx?.webplayout || "1"
		ografJson.customActions.forEach((index) => {
			DataFields.push({
				field: index.id,
				ftype: "button",
				title: index.name || index.id,
				fcall: `customActionHandler('${index.id}', '${webplayout}')`
			})
		})
	}

	const SPXGCTemplateDefinition = {
		description: ografJson.description || '',
		DataFields: DataFields,
		steps: ografJson.stepCount || 1,
		playserver: ografJson.v_spx?.playserver || "OVERLAY",
		playchannel: ografJson.v_spx?.playchannel || "1",
		playlayer: spx.max5(ografJson.v_spx?.playlayer) || "1",
		webplayout: spx.max5(ografJson.v_spx?.webplayout) || "1",
		out: ografJson.v_spx?.out || "manual",
		uicolor: ografJson.v_spx?.uicolor || "0",
		ografProps: {
			id: ografJson.id,
			version: ografJson.version,
		},
		imported: String(Date.now())
	};

	if (!SPXGCTemplateDefinition.DataFields || SPXGCTemplateDefinition.DataFields.length === 0) {
		let emptyData = {}
		emptyData.ftype = 'instruction'
		emptyData.value = 'No editable fields'
		SPXGCTemplateDefinition.DataFields = [emptyData];
	}

	let absPath = TemplatePath.split("\\").join("/");
	let templateRootPath = path.join(spx.getStartUpFolder(), 'ASSETS', 'templates');
	let tmpRoot = templateRootPath.split("\\").join("/");
	let relpath = absPath.split(tmpRoot)[1];
	SPXGCTemplateDefinition.relpath = relpath;

	if (relpath && relpath.match(/\/[^\/]+\.ograf\.json$/)) {
		relpath = relpath.replace(/\/[^\/]+\.ograf\.json$/, '');
	}
	const graphicPath = relpath + '/' + ografJson.main;
	SPXGCTemplateDefinition.ografProps.graphicPath = graphicPath;

	if (profileData.templates) {
		if (replaceIndex) {
			profileData.templates[replaceIndex] = SPXGCTemplateDefinition;
		} else {
			profileData.templates.push(SPXGCTemplateDefinition);
		}
	} else {
		profileData.templates = [SPXGCTemplateDefinition];
	}

	return profileData;
}

function addTemplateToProfile(profileData, TemplatePath, showFolder, curFolder, replaceIndex = null) {
	if (TemplatePath.toLowerCase().endsWith(".ograf.json")) {
		profileData = addOgrafTemplateToProfile(profileData, TemplatePath, showFolder, curFolder, replaceIndex);
		return profileData;
	}

	let SPXGCTemplateDefinition = null;
	let gddDefinition = null; // Graphics Data Definition
	let spxDefinition = null; // SPX Template Definition

	if (replaceIndex) {
		TemplatePath = path.join(spx.getStartUpFolder(), 'ASSETS', 'templates', TemplatePath)
		global.LastBrowsedTemplateFolder = path.join(spx.getStartUpFolder(), 'ASSETS', 'templates', curFolder); // Bugfix added in 1.1.1
	} else {
		global.LastBrowsedTemplateFolder = curFolder;
	}

	logger.verbose('Added template: ' + TemplatePath);
	let templateContents = fs.readFileSync(TemplatePath, "utf8")
	let templatehtml = templateContents.toString();

	let importMessage = '\n\n- SPX TEMPLATE IMPORT NOTIFICATION --------------------------------\n';
	importMessage += ' Potential errors below this notification are from the template:\n';
	importMessage += ' ' + TemplatePath + '\n\n';
	importMessage += ' onLoad() or other root functions in the template MAY yield errors\n';
	importMessage += ' or other messages during import and these can usually be ignored\n';
	importMessage += ' safely. For more info search SPX KnowledgeBase for "Import errors".\n';
	importMessage += '-------------------------------------------------------------------\n';
	console.log(importMessage)
	const dom = new JSDOM(templatehtml, { runScripts: "dangerously" });
	SPXGCTemplateDefinition = dom.window.SPXGCTemplateDefinition; // Mandatory!

	if (!SPXGCTemplateDefinition.description) { SPXGCTemplateDefinition.description = "" };
	if (!SPXGCTemplateDefinition.playserver) { SPXGCTemplateDefinition.playserver = "-" };
	if (!SPXGCTemplateDefinition.playchannel) { SPXGCTemplateDefinition.playchannel = "1" };
	if (!SPXGCTemplateDefinition.playlayer) { SPXGCTemplateDefinition.playlayer = "5" };
	if (!SPXGCTemplateDefinition.webplayout) { SPXGCTemplateDefinition.webplayout = "5" };
	if (!SPXGCTemplateDefinition.onair) { SPXGCTemplateDefinition.onair = "false" };
	if (!SPXGCTemplateDefinition.out) { SPXGCTemplateDefinition.out = "manual" };
	if (!SPXGCTemplateDefinition.dataformat) { SPXGCTemplateDefinition.dataformat = "json" };
	if (!SPXGCTemplateDefinition.uicolor) { SPXGCTemplateDefinition.uicolor = "0" };
	if (!SPXGCTemplateDefinition.webplayout) { SPXGCTemplateDefinition.webplayout = "5" };
	if (!SPXGCTemplateDefinition.playlayer) { SPXGCTemplateDefinition.playlayer = "5" };

	if (parseInt(SPXGCTemplateDefinition.webplayout) > 5) {
		SPXGCTemplateDefinition.webplayout = "5";
	}

	if (parseInt(SPXGCTemplateDefinition.playlayer) > 5) {
		SPXGCTemplateDefinition.playlayer = "5";
	}

	SPXGCTemplateDefinition.imported = String(Date.now());

	if (!SPXGCTemplateDefinition.DataFields || SPXGCTemplateDefinition.DataFields.length === 0) {
		let emptyData = {}
		emptyData.ftype = 'instruction'
		emptyData.value = 'No editable fields'
		SPXGCTemplateDefinition.DataFields = [emptyData];
	}

	let absPath = TemplatePath.split("\\").join("/");
	let templateRootPath = path.join(spx.getStartUpFolder(), 'ASSETS', 'templates');
	let tmpRoot = templateRootPath.split("\\").join("/");
	SPXGCTemplateDefinition.relpath = absPath.split(tmpRoot)[1];

	if (profileData.templates) {
		if (replaceIndex) {
			profileData.templates[replaceIndex] = SPXGCTemplateDefinition;
		} else {
			profileData.templates.push(SPXGCTemplateDefinition);
		}
	} else {
		profileData.templates = [SPXGCTemplateDefinition];
	}

	profileData.templates.forEach(function (template, index) {
		template.DataFields.forEach(function (field, index) {
			if (field.prvar) {
				console.log('WIP - Found prvar in template field: ' + field.prvar);
				if (!profileData.variables) {
					profileData.variables = [];
				}
				// TODO: Bug here! This will overwrite existing variables with same name!
				let foundOld = false;
				profileData.variables.forEach(function (variable, index) {
					if (variable.prvar === field.prvar) {
						console.log('WIP - Found existing variable: ' + variable.prvar);
						foundOld = true;
						variable.ftype = field.ftype;
						variable.title = field.title;
						variable.value = field.value;
						if (!variable.users.includes(template.relpath)) {
							variable.users.push(template.relpath);
						}
					}
				})

				if (!foundOld) {
					let varItem = {}
					varItem.prvar = field.prvar;
					varItem.ftype = field.ftype;
					varItem.title = field.title;
					varItem.value = field.value;
					varItem.users = [template.relpath];
					profileData.variables.push(varItem);
				}
			}
		})
	})
	return profileData;
} // addTemplateToProfile ended


async function orgGetDataFiles(FOLDERstr) {
	logger.debug("Getting json files from " + FOLDERstr + "...");
	let FOLDER = path.normalize(FOLDERstr);
	let jsonData = {};
	var key = 'files';
	jsonData.folder = FOLDER;
	jsonData[key] = [];
	let id = 0;
	try {
		fs.readdirSync(FOLDER).forEach(file => {
			let bname = path.basename(file, '.json');
			logger.debug("Getting file " + bname + "...");
			let ext = path.extname(file).toUpperCase();
			if (ext == ".JSON") {
				var stats = fs.statSync(path.join(FOLDER, file));
				var datem = moment(stats.mtime, 'DD.MM.YYYY').format();
				var filedata = {
					id: id,
					name: bname,
					date: datem
				};
				id++;
				jsonData[key].push(filedata);
			}
		});
		return jsonData;
	}
	catch (error) {
		logger.error('orgGetDataFiles / Failed to read folder ' + FOLDERstr + ': ' + error);
		return (error);
	}
} // orgGetDataFiles ended


async function GetTextFileData(fileref) {
	try {
		if (fs.existsSync(fileref)) {
			var contents = fs.readFileSync(fileref, 'utf8') || '';
			logger.debug('GetTextFileData: returns data from [' + fileref + ']');
			return contents;
		}
		else {
			logger.debug('GetTextFileData: file does not exist [' + fileref + '], returning empty string.');
			return '';
		}

	}
	catch (error) {
		logger.error('GetTextFileData Error: ' + error);
		return ('GetTextFileData: error', error);
	}
} // GetTextFileData ended


async function GetJsonData(fileref) {
	try {
		if (fs.existsSync(fileref)) {
			var contents = fs.readFileSync(fileref, 'utf8') || '';
			logger.debug('GetJsonData: returns data from [' + fileref + ']');
			return JSON.parse(contents);
		}
		else {
			logger.debug('GetJsonData: file does not exist [' + fileref + '], returning null.');
			return false;
		}

	}
	catch (error) {
		let msg = 'GetJsonData error while reading ' + fileref + '. Invalid JSON format...? ' + error;
		setTimeout(function () {
			io.emit('SPXMessage2Controller', {
				APIcmd: 'showMessageSlider',
				msg: '<center>Invalid rundown file.<br>Please validate JSON data.</center>',
				type: 'warn',
				persist: true
			});
		}, 1000);


		logger.error(msg);
		return false; // like a missing file: callers check for a falsy result
	}
} // GetJsonData ended



function getResolutionFromConfig(cfg, postRequest) {
	let sizeID = cfg.general.resolution || 'HD';
	let width = '1920px';
	let height = '1080px';
	if (postRequest.width) { width = postRequest.width }
	if (postRequest.height) { height = postRequest.height }
	switch (sizeID) {
		case '4K':
			width = '3840px'
			height = '2160px'
			break;

		case 'AUTO':
			width = '100vw'
			height = '100vh'
			break;

		default:
			// HD is the default
			width = '1920px'
			height = '1080px'
			break;
	};

	return {
		width: width,
		height: height,
	};
} // getResolutionFromConfig ended


module.exports = router;
