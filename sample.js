const FTXWs = require('./');

// including private channels:
// const ftx = new FTXWs({
//   key: 'x',
//   secret: 'y',
//   subaccount: 'z'
// })

// only public channels:
const ftx = new FTXWs();

const go = async () => {
  await ftx.connect();

  ftx.subscribe('ticker', 'BTC-PERP');
  ftx.on('BTC-PERP::ticker', console.log);

  // if you passed api credentials:
  ftx.subscribe('fills');
  ftx.on('fills', console.log);
}

go();