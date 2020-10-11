require('dotenv').config()

let DEBUG = true;
//
let socketIO = require('socket.io');
let express = require('express');
let app = express();
//
const cpaas = require('@avaya/cpaas');
//
const parsePhoneNumber = require('libphonenumber-js')
//
const options = {
  port: 8090,
  server: 'https://051ca898ce76.ngrok.io',
  agents: JSON.parse(process.env.AGENT_LIST),
  ourNumber: ''
};

let activeLog = [];



function purifyMessage(msg = '') {
  msg = msg.replace(process.env.AVAYA_SID, '(AVAYA_SID)');
  msg = msg.replace(process.env.AVAYA_AUTH, '(AVAYA_AUTH)');

  msg = msg.replace(options.ourNumber, '(ourNumber)');

  Object.keys(activeLog).forEach((CallSid) => {
    msg = msg.replace(CallSid, `(CallSid ***${CallSid.substr(-3)})`);
  });

  options.agents.forEach((num) => {
    msg = msg.replace(num, `(AgentNumber ***${num.substr(-3)})`);
  });

  return msg;
}

function log(msg = '') {
  if (DEBUG) {
    msg = purifyMessage(msg);
    console.log(msg);
  }
}

function tracelog(msg) {
  //console.log(msg);
}

function showConfig() {
  log(`Server at ${options.server}`);

  options.agents.forEach((num) => {
    log(`Agent: ${num}`);
  });
}

showConfig();
log(`Launching server on port ${options.port}`);

const server = app.listen(options.port, '0.0.0.0', function() {
  log(`Ready on port ${options.port}`);
});

app.use(express.static('public'));
app.use(express.static('/assets'));

app.get('/sys/log', function(req, res) {
  log('sys/log:')
  log(req.params);
  log(req.query);

  res.send('Data logged');
});

app.get('/sys/voxlog', function(req, res) {
  log('sys/voxlog:')

  const ix = cpaas.inboundXml;
  const enums = cpaas.enums;
  const instructionList = [];

  instructionList.push(ix.say({
    text: 'Logs goes here...'
  }));

  instructionList.push(ix.hangup({}));

  const xmlResponse = ix.response({content: instructionList});
  ix.build(xmlResponse)
  .then((xml) => {
    log(xml)
    res.send(xml)
  })

});

app.get('/sys/callback', function(req, res) {
  log('sys/callback');

  const ac = new cpaas.Connectors({
      accountSid: process.env.AVAYA_SID,
      authToken: process.env.AVAYA_AUTH
  }).calls;

  ac.makeCall( {
    to: options.agents[0],
    from: options.ourNumber,
    url: `${options.server}/sys/voxlog`,
    method: 'GET',

  });

  res.send('Call me back initiated');
});


app.get('/sys/active', function(req, res) {
    res.send(JSON.stringify(activeLog));
});

app.get('/sys/calls', function(req, res) {
  let html = '';
  let agentNumber = getAgentNumber();

  html += `<p>Hello agent. Please take a call...</p>`;

  Object.keys(activeLog).forEach((CallSid) => {
    let line = `<a href='/sys/handle/${CallSid}/${agentNumber}'>Handle call <b>${CallSid}</b></a>`;
    html += `<p>${line}</p>`;
  });

  html += `<p><a href='#' onclick='location.reload()'>Reload</a></p>`;

  res.send(html);
});

app.get('/sys/handle/:CallSid/:NewNumber', function(req, res) {
  log(`Agent '${req.params.NewNumber}' has agreed to handle call ${req.params.CallSid}`);

  createInstructionForwardTo(req.params.CallSid, req.params.NewNumber);

  let html = `Redirection in place...`;
  html += `<a href='/sys/calls'>Return to calls list</a>`;
  res.send(html);
});


app.get('/sys/connect/:CallSid/:NewNumber', function(req, res) {
  const ix = cpaas.inboundXml;
  const enums = cpaas.enums;
  const instructionList = [];

  log(`Connecting '${req.params.NewNumber}' to call ${req.query.CallSid}`);

  let CallSid = req.query.CallSid;
  activeLog[CallSid].callUnderway = true;

  instructionList.push(ix.say({
    text: 'Connecting you now'
  }));

  instructionList.push(ix.dial({
    action: `${options.server}/sys/log`,
    method: 'GET',
    // TODO: I can't use a custom callerID
    // and hide appears to not work
    //callerID: 'TADHack2020',
    hideCallerId: true,
    content: ix.number({
      number: req.params.NewNumber
    })
  }));

  const xmlResponse = ix.response({content: instructionList});
  ix.build(xmlResponse)
  .then((xml) => {
    log(xml)
    res.send(xml)
  })
  .then(() => {
    // I couldn't find a way to stop the music playing, so we start silence,
    // which causes the previous one to stop.
    let playURL = `${options.server}/assets/null.mp3`;
    createInstructionNewPlaylist(CallSid, playURL);
  })

});

function getLanguageCodeFromNumber(fromNumber) {
  const phoneNumber = parsePhoneNumber(fromNumber);

  // Country code is one of
  // https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2

  // Language codes from inbound.xml#say
  switch(phoneNumber.country) {
    case 'US':
    return 'en-us';

    case 'GB':
    return 'en-gb';

    case 'FR':
    return 'fr-fr';

    case 'DE':
    return 'de-de';
  }

  // Otherwise...
  return 'en-gb';
}

app.get('/api/:supplier/incoming', function(req, res) {
  const languageCode = getLanguageCodeFromNumber(req.query.From);

  activeLog[req.query.CallSid] = {
    query: req.query,
    playURL: undefined,
    canWeInterupt: false, // this means that, at least, the first 'welcome' message is heard
    callUnderway: false
  };

  const ix = cpaas.inboundXml;
  const enums = cpaas.enums;
  const instructionList = [];

  instructionList.push(ix.say({
    text: `You have reached the geeky TAD hack`,
    language: languageCode
  }));

  instructionList.push(ix.pause({length:1}));

  instructionList.push(ix.say({
    text: 'This is Spotify On Hold',
    language: languageCode
  }));

  // prevent the call from hanging up via timeout
  instructionList.push(ix.pause({length:999}));

/*
  instructionList.push(ix.play({
    url: `${options.server}/assets/test.mp3`
  }));
*/
  // go and find some music in the background
  requestSpotifyPlaylist({phone: req.query.From})
  .then((playlist) => {
    let firstSong = playlist.url[0];
    log(`Playlist is ready with: ${firstSong}`);
    activeLog[req.query.CallSid].playURL = firstSong;
  })

  const xmlResponse = ix.response({content: instructionList});
  ix.build(xmlResponse)
  .then((xml) => {
    log(xml)
    res.send(xml)
  })
  .then(() => {
    activeLog[req.query.CallSid].canWeInterupt = true;
    bumpInteruptCheck(req.query.CallSid);
  })

});

function getAgentNumber() {
  return options.agents[1];
}

function bumpInteruptCheck(CallSid) {
  if (activeLog[CallSid].callUnderway) {
    // NOP - We started talking with the agent during the setTimeout period
    // so don't retrigger the sound
  } else if (activeLog[CallSid].canWeInterupt && activeLog[CallSid].playURL) {
    // We need both the opportunity to play, and a tune. When both are ready
    // we play it!
    createInstructionNewPlaylist(CallSid);
  } else {
    // Otherwise, try again shortly...
    setTimeout(function() {
      bumpInteruptCheck(CallSid);
    }, 100);
  }
}


function createInstructionNewPlaylist(CallSid, playURL) {
const enums = cpaas.enums;
const firstSong = playURL || activeLog[CallSid].playURL;
const ac = new cpaas.Connectors({
    accountSid: process.env.AVAYA_SID,
    authToken: process.env.AVAYA_AUTH
}).calls;

  log(`createInstructionNewPlaylist for ${CallSid}`);

  ac.playAudioToLiveCall({
    callSid: CallSid,
    audioUrl: firstSong,
    direction: enums.RecordingAudioDirection.IN,
    loop: false
  })
  .then((r) => {
    tracelog('r:', r)
  })
  .catch((e) => {
    tracelog('e:', e)
  })
}


function createInstructionForwardTo(CallSid, newNumber) {
const enums = cpaas.enums;
const ac = new cpaas.Connectors({
    accountSid: process.env.AVAYA_SID,
    authToken: process.env.AVAYA_AUTH
}).calls;

log(`forwarding ${CallSid} to...`)

  ac.interruptLiveCall({
    callSid: CallSid,
    url: `${options.server}/sys/connect/${CallSid}/${newNumber}`,
    method: enums.HttpMethod.GET,
    status: enums.EndCallStatus.COMPLETED
  })
  .then((r) => {
    tracelog('rf:', r)
  })
  .catch((e) => {
    tracelog('ef:', e)
  })
}

function requestSpotifyPlaylist(opts) {
  let userPhone = opts.phone;
  // NOTE - you need a Pro Spotify to use the API so using this
  // variation which will work for everyone
  let url = userPhone === options.agents[0] ? `${options.server}/assets/test1.mp3` : `${options.server}/assets/test2.mp3`;

  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        url: [
          url
        ]});
    }, 50);
  })
}

