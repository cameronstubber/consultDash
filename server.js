var path = require('path');
var serialport = require("serialport");
var SerialPort = serialport.SerialPort;

const { MongoClient } = require('mongodb');

const password = encodeURIComponent('P@ssword1');
const username = encodeURIComponent('cameron');
let prod_mongo_uri = `mongodb+srv://${username}:${password}@bluey-mongo-cluster.mongocluster.cosmos.azure.com/?tls=true&authMechanism=SCRAM-SHA-256&retrywrites=false&maxIdleTimeMS=120000`
const serialPortPath = '/dev/ttyUSB0';
const serialPortBaudRate = 9600;


const db = new MongoClient(prod_mongo_uri);


async function getTelemetryCollection() {
  try {
    await db.connect();
    const database = db.db('bluey');
    return database.collection('telemetry');
  } catch (err) {
    console.error('MongoDB connection error:', err);
    throw err;
  }
}

let dbCollection = getTelemetryCollection();
console.log('Database Connected');

var sp = new SerialPort(serialPortPath, { baudrate: serialPortBaudRate });

// All the values we are getting from the ECU
var rpm, kph, coolantTemp = 0;

// Globals
var currentData= [];
var frameStarted = false;
var lengthByte;
var isConnected = false;
var command = [0x5A,0x08,0x5A,0x00,0x5A,0x01,0x5A,0x0b,0xF0];
var bytesRequested = (command.length - 1) / 2;

function handleData(data, bytesExpected){
  // create an array of the size of requested data length and fill with requested data
  for(var i = 0; i < data.length; i++){
    // read just 1 byte at a time of the stream
    var char = data.toString('hex',i,i+1);
    if(char === "ff"){
      // Beginning of data array, the frame has started
      frameStarted = true;
      // Get rid of last frame of data
      currentData = [];
      // remove last lengthByte number so that we can check what this frame's byte should be
      lengthByte = undefined;
    }else if(frameStarted){
      // frame has started
      if(!lengthByte){
        // read lengthByte from the ECU
        lengthByte = parseInt(char, 16);
      }else{
        // push byte of data onto our array
        currentData.push(parseInt(char, 16));
      }
    }
  }
  if(currentData.length === bytesExpected){
    // End of data, return the array of data
    frameStarted = false;
    return currentData.slice();
  }
}

function convertRPM(mostSignificantBit, leastSignificantBit){
  // combine most significant bit and least significant bit and convert to RPM
  return ((mostSignificantBit << 8) + leastSignificantBit) * 12.5;
}

function convertCoolantTemp(data){
  // Subtract 50 for Celsius
  var celciusCoolantTemp = data - 50;
  return celciusCoolantTemp;
}

function convertKPH(data){
  // data * 2 gives KPH
  return data * 2;
}

function parseData(data){

  if(data !== undefined){
    coolantTemp = convertCoolantTemp(data[0]);
    rpm = convertRPM(data[1], data[2]);
    kph = convertKPH(data[3]);
  }

}

async function pushToDatabase(data) {
  try {
    await dbCollection.insertOne(data);
  } catch (err) {
    console.error('MongoDB insert error:', err);
  } 
};

sp.on("open", function () {
  // Write initialization bytes to the ECU
  sp.write([0xFF, 0xFF, 0xEF], function(err, results) {});
  sp.on('data', function(data) {
    // Check to see if the ECU is connected and has sent the connection confirmation byte "10"
    if(!isConnected && data.toString('hex') === "10"){
      console.log("Bluey connected");
      isConnected = true;
      // Tell the ECU what data we want it to give us
      sp.write(command, function(err,results){});
    }else{
      // Read the data from the stream and parse it
      parseData(handleData(data, bytesRequested));
      pushToDatabase({
        rpm: Math.floor(rpm),
        kph: Math.floor(kph),
        coolantTemp: Math.floor(coolantTemp),
        timestamp: new Date()
      });
    }
  });
});
