
const fs = require('fs');
const logger = require('./logger.js');
const spx = require('../utils/spx_server_functions.js');
const access = require('./spx_access.js');

// Public API middleware (see spx_access.js). Kept under its old name.
const CheckAPIKey = access.requireApiAccess;


// Store the password as a current-format hash when it was saved in the
// legacy (reversible) format. Called after a successful login, the only
// time the plaintext is known.
function upgradeLegacyPassword(plaintext) {
  try {
    if (!spx.isLegacyHash(config.general.password)) return;
    const newHash = spx.hash(plaintext);
    const configData = JSON.parse(fs.readFileSync(global.configfileref, 'utf8'));
    configData.general.password = newHash;
    fs.writeFileSync(global.configfileref, JSON.stringify(configData, null, 2), 'utf8');
    config.general.password = newHash;
    logger.info('CheckLogin: stored password upgraded to the current hash format.');
  } catch (error) {
    logger.error('CheckLogin: could not upgrade the stored password hash: ' + error);
  }
}


async function CheckLogin(req,res,next) {
    // Middleware to check auth in each router.
    let USER = (req.body && req.body.username) || '';
    let PASS = (req.body && req.body.password) || '';
    let AllowedUser = config.general.username || '';

    // See if auth is used (if user in config is present)
    if (!AllowedUser){
      logger.verbose('CheckLogin: No username in config, authorize "default" user...');
      req.session.user = 'default';
      next();
      return;
    }

    // See if only user is present in config: ask for auth policy
    if (!config.general.password){
      logger.verbose('CheckLogin: No password in config, prompt for auth policy...');
      res.render('view-authpolicy', { layout: false, user: AllowedUser});
      return;
    }

    if (access.hasLoginSession(req)) {
      logger.verbose('CheckLogin: User "' + req.session.user + '" authorized ok.');
      next();
      return;
    }

    if (USER==AllowedUser && spx.hashcompare(PASS,config.general.password)) {
      upgradeLegacyPassword(PASS);
      // New session id on login (prevents session fixation).
      req.session.regenerate((err) => {
        if (err) {
          logger.error('CheckLogin: session error: ' + err);
          return res.redirect('/login');
        }
        logger.info('CheckLogin: User "' + USER + '" logged in.');
        req.session.user = USER;
        next();
      });
      return;
    }

    if (USER) {
      logger.warn('CheckLogin: failed login for user "' + USER + '".');
    } else {
      logger.verbose('CheckLogin: Not authenticated, redirect to login');
    }
    res.redirect('/login');
  } // CheckLogin


function Logout(req,res,next) {
  // logout user
  logger.info('CheckLogin: User "' + req.session.user + '" logged out.');
  req.session.destroy(() => res.redirect('/'));
}

module.exports = {
  CheckAPIKey,
  CheckLogin,
  Logout
}
