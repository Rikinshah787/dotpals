let s = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (s += c)).on('end', () => console.log('GOT ' + JSON.stringify(s)));
