// Local IP address lookup. Replaces the "ip" package, whose isPublic() has an
// unfixed SSRF advisory (GHSA-2p57-rm9w-gvfp); SPX only used ip.address().

const os = require('os');

// Same result as ip.address() of the "ip" package: the first IPv4 address
// that is not a loopback address, taking each network interface in order, or
// 127.0.0.1 if there is none.
function address() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const found = (interfaces[name] || []).find((details) => {
      // family is the number 4 in Node 18.0 - 18.3
      const isIPv4 = details.family === 'IPv4' || details.family === 4;
      return isIPv4 && !details.address.startsWith('127.');
    });
    if (found) {
      return found.address;
    }
  }
  return '127.0.0.1';
}

module.exports = { address };
