module.exports = {
  apiVersion: `v1`,
  logFileName: `hydra-print.log`,
  testLogFileName: `hydra-print-test.log`,
  virtualDelay: 1000,
  baudrate: 230400,
  vidPids: [
    {
      vid: 10612,
      pid: 1283,
    },
    {
      vid: 5824,
      pid: 1155,
    },
    {
      vid: 9025,
      pid: 66,
    },
    {
      vid: 7504,
      pid: 24597,
    },
    {
      vid: 9153,
      pid: 45079,
    },
  ],
  conductor: {
    enabled: false,
    comType: 'http',
    players: [
      'a',
      'b',
      'c',
      'd',
      'e',
    ],
  },
};
