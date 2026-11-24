// Pending server-side auto-outs of graphics played through the API (items
// with a numeric "out" time).
//
// Each pending auto-out is registered under the keys of what it stops: the
// rundown item it belongs to (if any) and its output layers. Scheduling or
// cancelling any of those keys cancels it, so a new play or stop of the same
// item, or on the same layers, replaces a pending auto-out instead of being
// cut short by it.

const path = require('path');

const pending = new Map(); // key -> entry { timer, keys }

// Key of a rundown item, from its rundown file path (".../<project>/data/<rundown>.json").
function itemKey(datafile, itemID) {
  const rundown = path.basename(String(datafile), '.json');
  const project = path.basename(path.dirname(path.dirname(String(datafile))));
  return 'item:' + project + '/' + rundown + '#' + itemID;
}

// Keys of the output layers of a playout: web renderer layer and/or CasparCG
// server, channel and layer.
function layerKeys({ playserver, playchannel, playlayer, webplayout }) {
  const keys = [];
  if (webplayout && webplayout != '-') {
    keys.push('web:' + webplayout);
  }
  if (playserver && playserver != '-') {
    keys.push('ccg:' + String(playserver).toLowerCase() + '/' + playchannel + '-' + playlayer);
  }
  return keys;
}

function cancel(keys) {
  for (const key of keys) {
    const entry = pending.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      remove(entry);
    }
  }
}

function remove(entry) {
  for (const key of entry.keys) {
    if (pending.get(key) === entry) {
      pending.delete(key);
    }
  }
}

// Runs stop() in `ms` milliseconds, unless one of `keys` is cancelled or
// scheduled again before that.
function schedule(keys, ms, stop) {
  cancel(keys);
  const entry = { keys: keys.slice() };
  entry.timer = setTimeout(() => {
    remove(entry);
    stop();
  }, ms);
  for (const key of entry.keys) {
    pending.set(key, entry);
  }
}

module.exports = { itemKey, layerKeys, schedule, cancel };
