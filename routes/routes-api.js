
// -----------------------------------------
// Handle Express server routes for the API (at "/api/")
// -----------------------------------------
var express = require("express");
const router = express.Router();
const path = require('path');
const fs = require('fs');
const moment = require('moment');
const directoryPath = path.normalize(config.general.dataroot);
const logger = require('../utils/logger');
logger.debug('API-route loading...');
const spx = require('../utils/spx_server_functions.js');
const xlsx = require('node-xlsx').default;
const access = require('../utils/spx_access.js');
const rundownStore = require('../utils/rundown_store.js');
const { resolveInside, isPlainName, openFolderInOS } = require('../utils/spx_paths.js');
const ui = access.requireUiAccess; // UI-internal endpoints, see utils/spx_access.js

// ROUTES -------------------------------------------------------------------------------------------
router.get('/', function (req, res) {
  res.send('Looking for this <a href="/api/v1/">api/v1</a>?');
});


router.get('/files', ui, async (req, res) => {
  const fileListAsJSON = await GetDataFiles();
  res.send(fileListAsJSON);
}); // file


router.get('/openFileFolder/', ui, async (req, res) => {
  // Opens ASSETS/<openFolderOnly>, or the folder of template <file>, in the
  // OS file manager. Only folders inside ASSETS can be opened.
  if (config.general.disableOpenFolderCommand == true) {
    let msg = 'openFileFolder -command disabled in config.';
    logger.warn(msg);
    return res.status(403).send(msg);
  }
  const assets = path.join(spx.getStartUpFolder(), 'ASSETS');
  let folder = null;
  if (req.query.openFolderOnly) {
    folder = resolveInside(assets, String(req.query.openFolderOnly));
  } else {
    if (!req.query.file) {
      let msg = 'openFileFolder -command requires a file parameter.';
      logger.warn(msg);
      return res.status(403).send(msg);
    }
    const filepath = resolveInside(path.join(assets, 'templates'), String(req.query.file));
    folder = filepath && path.dirname(filepath);
  }

  if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    logger.error('openFileFolder: folder not found in ASSETS: ' + (req.query.openFolderOnly || req.query.file));
    return res.status(404).send('Folder not found.');
  }

  openFolderInOS(folder);
  res.sendStatus(200)
}); // openFileFolder of a template for editing


router.get('/licBasic/', ui, async (req, res) => {
  // added in 1.1.1 - license check. Minor tweaks in 1.1.3
  // Format:
  // 4x?rot(pmac)10x? | AA-AA-33-UQ-GZ-ZX-BB-BB-BB-BB
  // Not safe because it is not encrypted.
  let stripd = req.query.str.replace(/-/g, '');  // strip dashes
  let rotlic = stripd.substring(4,12); // get 8 chars
  // console.log('rotlic // from: ' + rotlic + ' to ' + spx.rot(rotlic, true) + ' vs ' + global.pmac.toUpperCase());
  if (spx.rot(rotlic, true) === global.pmac.toUpperCase()) {
    res.status(200).send('{result:ok}');
  } else {
    res.status(403).send('{result:invalid}');
  }
}); // GET licBasic check ended


router.get('/rotBasic/', ui, async (req, res) => {
  // Require host-id, returns key.
  let rotlic = spx.rot(req.query.id);
  let soclic = spx.dashify(spx.salt(4) + rotlic + spx.salt(8));
  let revlic = spx.rot(rotlic, true);
  let json = "{\"pmac\":\"" + global.pmac + "\",\"rot\":\"" + rotlic + "\",\"soclic\":\"" + soclic + "\",\"chk\":\"" + revlic + "\"}";
  res.send(json);
}); // GET rotBasic/?id=12345678


// Minimalistic logger for template messages (GET query or POST body:
// message, source, channel, level). Templates call this without a login.
function logTemplateMessage(params, res) {
  const level = String(params.level || 'info').toLowerCase();
  if (!access.isLogLevel(level)) {
    return res.status(400).send('Unknown log level. Use error, warn, info, verbose or debug.');
  }
  logger[level]('(api/logger, ' + params.channel + ', ' + params.source + '): ' + params.message);
  res.sendStatus(200)
}

router.get('/logger/', (req, res) => logTemplateMessage(req.query || {}, res));

router.post('/logger/', (req, res) => logTemplateMessage(req.body || {}, res));


router.post('/browseFiles/', ui, async (req, res) => {
  // This is axios ajax handler for file browser on dbl click on a folder
  // REQUEST: current folder and next folder name
  // RETURNS: json data with folder and file arrays
  // 1.1.0 - refactored navigation process to use '..' for parent folder.
  // The browse root (rootFolder) must be inside ASSETS, and navigation
  // stops at the root.
  const assets = path.resolve(spx.getStartUpFolder(), 'ASSETS');
  let curFolder   = String(req.body.curFolder || ".");
  let tgtFolder   = String(req.body.tgtFolder || "");
  let extension   = req.body.extension || "HTM";
  let osRootPath  = resolveInside(assets, String(req.body.rootFolder || assets));
  if (!osRootPath) {
    logger.warn('browseFiles: root folder outside ASSETS refused: ' + req.body.rootFolder);
    return res.status(403).send('Browsing is limited to the ASSETS folder.');
  }

  let osTargPath = resolveInside(osRootPath, path.resolve(curFolder, tgtFolder));
  let navigateTo = osTargPath;
  let feedbackMs = '';

  if ( !osTargPath || osTargPath === osRootPath ) {
    logger.verbose('Targeting beyond limits, sending root-identifier. Path: '  + path.resolve(curFolder, tgtFolder));
    navigateTo = osRootPath;
    feedbackMs = 'root';
  } else {
    feedbackMs = 'ok';
  }
  const fileListAsJSON = await spx.GetFilesAndFolders(navigateTo, extension);
  fileListAsJSON.message=feedbackMs; // force feedback message to UI at RenderFolder()
  res.send(fileListAsJSON);
}); // POST browseFiles API route ended



router.post('/readExcelData', async (req, res) => {
  // Function can be called from a template to get all data from 
  // an Excel file in the ASSETS/excel -folder.
  // Data parsing / logic must be implemented in the template
  // this just dumps data out as-is.
  // var excelFile = path.join(__dirname, '..', 'ASSETS', req.body.filename); // fails when packaged
  // Improved in 1.1.1 - Return cached data also if fileref is empty (for some reason).
  try {
    // Templates call this without a login: only files inside ASSETS.
    var excelFile = resolveInside(path.join(spx.getStartUpFolder(), 'ASSETS'), req.body.filename || '');
    if (!excelFile) {
      logger.warn('readExcelData: file outside ASSETS refused: ' + req.body.filename);
      return res.status(403).send('Excel files must be inside the ASSETS folder.');
    }
    var workSheetsData;
    let timenow = Date.now(); 
    // console.log('Excel cache age ' + (timenow - excel.readtime) + ' ms');

    if ( excel.data && excel.filename == req.body.filename && (timenow - excel.readtime) <= 1000 || !req.body.filename ) { /* milliseconds */
      // sama data requested less than a second ago, return data from memory
      logger.verbose('Returning cached Excel data from memory')
      workSheetsData = excel.data;
      // console.log('Returning CACHED Excel data.\n');
    } else {
      // get it from Excel file
      logger.verbose('Returning Excel data from FILE and saving to cache.')
      workSheetsData = xlsx.parse(excelFile);
      // console.log('Returning Excel FILE data and caching it.\n');

      // cache excel data to a global variable
      global.excel.readtime = Date.now();
      global.excel.filename = req.body.filename;
      global.excel.data = workSheetsData;
    }

    
    logger.verbose('OK API read Excel data from ' + excelFile);
    res.status(200).send(workSheetsData); // ok 200 AJAX RESPONSE
    return;
  } catch (error) {
    logger.error('Error in api/readExcelData while reading Excel ' + excelFile + ": " + error);
    res.status(500).send(error);  }; // Server error
    return;
}); // POST readExcelData to get Excel data from file


router.post('/savefile/:filebasename', ui, async (req, res) => {
  spx.talk('Saving file ' + req.params.filebasename);
  let datafile = '';
  try {
    if (!req.params.filebasename) {
      throw new Error("Filename missing, cannot save file.");
    }
    datafile = resolveInside(directoryPath, req.params.filebasename + '.json');
    if (!datafile) {
      return res.status(403).send('Files can only be saved inside the dataroot folder.');
    }
    logger.debug('Saving file ' + datafile + '...');
    let data = req.body;
    await spx.writeFile(datafile,data);
    res.status(200).send('OK, created file ' + datafile); // ok 200 AJAX RESPONSE
  } catch (error) {
    logger.error('Error while saving ' + datafile + ': ' + error);
    res.status(500).send(String(error));
  }; //file written
}); // POST savefile API route ended

router.post('/saverundownfile/:projectName/:rundownName', ui, async (req, res) => {
  // Added in 1.3.0
  // Used by extensions that will modify rundowns and save them back to the server.
  // This will also send a message to the UI to request a reload.
  logger.verbose('Saving rundown file ' + req.params.rundownName + ' in project ' + req.params.projectName + '...');
  try {
    if (!isPlainName(req.params.projectName) || !isPlainName(req.params.rundownName)) {
      return res.status(400).send('Project and rundown must be plain names.');
    }
    let datafile = resolveInside(directoryPath, req.params.projectName, 'data', req.params.rundownName + '.json');
    if (!datafile) {
      return res.status(403).send('Rundowns can only be saved inside the dataroot folder.');
    }
    logger.debug('Saving rundown file ' + datafile + '...');
    // Through the rundown store, so a later play does not write the old
    // in-memory copy over these changes.
    await rundownStore.withLock(datafile, async () => {
      const data = req.body;
      spx.appendProjectFile(data, datafile);
      rundownStore.set(datafile, data);
      await spx.writeFile(datafile, data);
    });
    io.emit('SPXMessage2Client', {
      spxcmd: "showMessageSlider",
      msg:    "⛔ Rundown data was modified by API. Reload view!",
      type:   "warn",
      persist: true
    });
    res.status(200).send('OK, created file ' + datafile); // ok 200 AJAX RESPONSE
  } catch (error) {
    logger.error('Error in api/saverundownfile' + error);
    res.status(500).send(error);
  }; //file written
}); // POST savefile API route ended


router.post('/exportCSVfile', ui, async (req, res) => {
  // console.log('Exporting CSV...');
  try {
    let showFolder  = req.body.foldername || "";
    let datafile    = req.body.datafile || "";
    if (!isPlainName(showFolder) || !isPlainName(datafile)) {
      return res.status(400).send('foldername and datafile must be plain names.');
    }
    let dataJSONfile= path.join(spx.getDatarootFolder(), showFolder, 'data', datafile + '.json'); // Changed in 1.3.1
    let rundownData = await spx.GetJsonData(dataJSONfile);
    let CSVdata = ''

    let item_description,
        item_playserver,
        item_playchannel,
        item_playlayer,
        item_webplayout,
        item_out,
        item_uicolor,
        item_dataformat,
        item_relpath,
        item_graphicPath,
        item_version,
        item_id

    rundownData.templates.forEach((item,index) => {
      // console.log('Iterating template index ' + index);
      if (item.itemID == req.body.itemID) {
        // This is the template to process.
        // console.log('Exporting template ' + item.itemID);

        item_description = item.description || '';
        item_playserver  = item.playserver  || '';
        item_playchannel = item.playchannel || '1';
        item_playlayer   = item.playlayer || '10';
        item_webplayout  = item.webplayout  || '10';
        item_out         = item.out || 'manual';
        item_uicolor     = item.uicolor || '0';
        item_dataformat  = item.dataformat || 'json';
        item_relpath     = item.relpath || '';        
        // if OGraf, we need to add a few more properties:
        if (item_relpath.toLowerCase().endsWith(".ograf.json")) {
          item_graphicPath = item.ografProps.graphicPath || '';
          item_version     = item.ografProps.version || '';
          item_id          = item.ografProps.id || '';
        }

        CSVdata  = '\r\n# SPX Rundown item CSV export. (More info: https://docs.spxgraphics.com/Guides/Tutorials/how+to+use+csv+files)\r\n\r\n' 
        CSVdata += '# description #;' + item_description + '\r\n' 
        CSVdata += '# playserver #;' + item_playserver + '\r\n'
        CSVdata += '# playchannel #;' + item_playchannel + '\r\n'
        CSVdata += '# playlayer #;' + item_playlayer + '\r\n'
        CSVdata += '# webplayout #;' + item_webplayout + '\r\n'
        CSVdata += '# out #;' + item_out + '\r\n'
        CSVdata += '# uicolor #;' + item_uicolor + '\r\n'
        CSVdata += '# dataformat #;' + item_dataformat + '\r\n'
        CSVdata += '# relpath #;' + item_relpath + '\r\n'        
        // if OGraf, add graphicPath, version and id
        if (item_relpath.toLowerCase().endsWith(".ograf.json")) {
          CSVdata += '# graphicPath #;' + item_graphicPath + '\r\n';
          CSVdata += '# version #;' + item_version + '\r\n';
          CSVdata += '# id #;' + item_id + '\r\n';
        }
        CSVdata += '# onair #;false\r\n'
        CSVdata += '# project #;' + showFolder  + '\r\n'
        CSVdata += '# rundown #;' + datafile  + '\r\n'
        CSVdata += '\r\n'

        // print field ID's
        CSVdata += '# FieldUUIDs #;'
        item.DataFields.forEach((field,findex) => {
          if (field.field && field.field!='' ) {
            CSVdata += field.field + ';'
          }
        });
        CSVdata += '\r\n';

        // print field types
        CSVdata += '# FieldTypes #;'
        item.DataFields.forEach((field,findex) => {
          if (field.field && field.field!='' ) {
            CSVdata += field.ftype + ';'
          }
        });
        CSVdata += '\r\n'

        // print field titles
        CSVdata += '# FieldTitls #;'
        item.DataFields.forEach((field,findex) => {
          if (field.field && field.field!='' ) {
            CSVdata += field.title + ';'
          }
        });
        CSVdata += '\r\n'

        // print field fcalls if button
        CSVdata += '# Fieldfcalls #;'
        item.DataFields.forEach((field,findex) => {
          if (field.field && field.field!='' && field.fcall) {
            CSVdata += field.fcall + ";";
          }

        });
        CSVdata += '\r\n'

        // print field values
        CSVdata += '\r\n'
        let itemData = '# ID:auto;'
        item.DataFields.forEach((field,findex) => {
          if (field.field && field.field!='' && field.value) {
            let dataToSave = field.value.replace(/\n/g,'<BR>') || ''; // replace all newlines with <BR>
            itemData += dataToSave + ";";
          }
        });
        CSVdata += itemData + '\r\n'
      }
    });

    let timestamp  = spx.prettifyDate(new Date(), 'YYYY-MM-DD-HHMMSS');
    let filenameref = item_relpath.split('.')[0].replace('\\', '/').split('/').slice(-1)[0];

    // generate CSV folder if not there
    let CSVfolder = path.join(spx.getStartUpFolder(), 'ASSETS', 'csv')
    fs.existsSync(CSVfolder) || fs.mkdirSync(CSVfolder)
    let CSVfileRef = path.join(CSVfolder, filenameref + '_' + timestamp + '.csv');
    await spx.writeTextFile(CSVfileRef,CSVdata);
    // console.log(' Created CSV file ' + CSVfileRef);
    logger.verbose('Created ' + CSVfileRef + ' from itemID ' + req.body.itemID + ' on ' + dataJSONfile + '. ');
    res.status(200).send('Generated file ' + CSVfileRef);
  } catch (error) {
    logger.error('API error in exportCSVfile(): ' + error);
    res.status(500).send('CSV export failed: ' + error);
  }; //file written
}); // POST exportCSVfile end


// FUNCTIONS -------------------------------------------------------------------------------------------
async function GetDataFiles() {
  // Get files
  // const directoryPath = path.normalize("X:/01_Projects/Yle/CG/DEV/DATA_FOLDER/");
  const directoryPath = path.normalize(config.general.dataroot);
  let jsonData = {};
  var key = 'files';
  jsonData.folder = directoryPath;
  jsonData[key] = [];
  let id = 0;

  try {
    fs.readdirSync(directoryPath).forEach(file => {
      let ext = path.extname(file).toUpperCase();
      if (ext == ".JSON") {
        var stats = fs.statSync(path.join(directoryPath, file));
        var datem = moment(stats.mtime, 'DD.MM.YYYY').format();
        var filedata = {
          id: id,
          name: file,
          date: datem
        };
        id++;
        jsonData[key].push(filedata);
      }
    });
    return jsonData;
  }
  catch (error) {
    logger.error('Error while reading files from ' + directoryPath + ': ' + error);
    return { folder: directoryPath, files: [], error: String(error) };
  }
} // GetDataFiles ended


module.exports = router;