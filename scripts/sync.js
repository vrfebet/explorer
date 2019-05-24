var mongoose = require('mongoose'),
	db = require('../lib/database'),
	Tx = require('../models/tx'),
	Address = require('../models/address'),
	AddressTx = require('../models/addresstx'),
	Richlist = require('../models/richlist'),
	Stats = require('../models/stats'),
	settings = require('../lib/settings'),
	fs = require('fs');

// log proces sync - https://github.com/log4js-node/log4js-node
const log4js = require('log4js');

log4js.configure({
  appenders:{ 
    everything: { type: 'file', filename: 'sync_block.log', maxLogSize: 10485760, backups: 10, compress: true }, 
    logsBlock: { type: 'file', filename: 'BlocksGet.log', maxLogSize: 10485760, backups: 10, compress: true }, 
    console: { type: 'console' }  
    },
      
  categories:{
    default: { appenders: ['console','everything'], level: 'info'},
    BlocksGet: { appenders: ['console','logsBlock'], level: 'debug'},
    OnlyShow: { appenders: ['console'], level: 'trace'}               
    },
  disableClustering: true
});
const logger = log4js.getLogger();
const onlyConsole = log4js.getLogger('OnlyShow');     
const blocksLog = log4js.getLogger('BlocksGet');     

var MaxPerWorker = 20;
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;

var mode = 'update';
var database = 'index';

// displays usage and exits
function usage() {
	console.log('Usage: node scripts/sync.js [database] [mode]');
	console.log('');
	console.log('database: (required)');
	console.log('index [mode] Main index: coin info/stats, transactions & addresses');
	console.log('market       Market data: summaries, orderbooks, trade history & chartdata')
	console.log('');
	console.log('mode: (required for index database only)');
	console.log('update       Updates index from last sync to current block');
	console.log('check        checks index for (and adds) any missing transactions/addresses');
	console.log('reindex      Clears index then resyncs from genesis to current block');
	console.log('');
	console.log('notes:');
	console.log('* \'current block\' is the latest created block when script is executed.');
	console.log('* The market database only supports (& defaults to) reindex mode.');
	console.log('* If check mode finds missing data(ignoring new data since last sync),');
	console.log('  index_timeout in settings.json is set too low.')
	console.log('');
	process.exit(0);
}

// check options
if (process.argv[2] == 'index') {
	if (process.argv.length < 3) {
		usage();
	} else {
		switch (process.argv[3]) {
			case 'update':
				mode = 'update';
				break;
			case 'check':
				mode = 'check';
				break;
			case 'reindex':
				mode = 'reindex';
				break;
			default:
				usage();
		}
	}
} else if (process.argv[2] == 'market') {
	database = 'market';
} else {
	usage();
}

function create_lock(cb) {
	if (database == 'index') {
		var fname = './tmp/' + database + '.pid';
		fs.appendFile(fname, process.pid, function(err) {
			if (err) {
				//console.log("Error: unable to create %s", fname);
				logger.error("Error: unable to create %s", fname);
				process.exit(1);
			} else {
				return cb();
			}
		});
	} else {
		return cb();
	}
}

function remove_lock(cb) {
	if (database == 'index') {
		var fname = './tmp/' + database + '.pid';
		fs.unlink(fname, function(err) {
			if (err) {
				//console.log("unable to remove lock: %s", fname);
				logger.error("unable to remove lock: %s", fname);
				process.exit(1);
			} else {
				return cb();
			}
		});
	} else {
		return cb();
	}
}

function is_locked(cb) {
	if (database == 'index') {
		var fname = './tmp/' + database + '.pid';
		fs.exists(fname, function(exists) {
			if (exists) {
				return cb(true);
			} else {
				return cb(false);
			}
		});
	} else {
		return cb();
	}
}

function exit() {
	remove_lock(function() {
		mongoose.disconnect();
		process.exit(0);
	});
}

//https://stackoverflow.com/questions/6312993/javascript-seconds-to-time-string-with-format-hhmmss
String.prototype.toHHMMSS = function() {
	var sec_num = parseInt(this, 10); // don't forget the second param
	var hours = Math.floor(sec_num / 3600);
	var minutes = Math.floor((sec_num - (hours * 3600)) / 60);
	var seconds = sec_num - (hours * 3600) - (minutes * 60);

	if (hours < 10) {
		hours = "0" + hours;
	}
	if (minutes < 10) {
		minutes = "0" + minutes;
	}
	if (seconds < 10) {
		seconds = "0" + seconds;
	}
	return hours + ':' + minutes + ':' + seconds;
}

var dbString = 'mongodb://' + settings.dbsettings.user;
dbString = dbString + ':' + settings.dbsettings.password;
dbString = dbString + '@' + settings.dbsettings.address;
dbString = dbString + ':' + settings.dbsettings.port;
dbString = dbString + '/' + settings.dbsettings.database;

is_locked(function(exists) {
	if (exists && cluster.isMaster) {
		//console.log("Script already running..");
		onlyConsole.trace("Script already running..");
		process.exit(0);
	} else {
		create_lock(function() {
			//console.log("script launched with pid: " + process.pid);
			logger.info("script launched with pid: " + process.pid);
			mongoose.connect(dbString, {
				useNewUrlParser: true
			}, function(err) {
				if (err) {
					//console.log('Unable to connect to database: %s', dbString);
					//console.log('Aborting');
					onlyConsole.trace('Unable to connect to database: %s', dbString);
					onlyConsole.trace('Aborting');
					exit();
				} else if (database == 'index') {
					db.check_stats(settings.coin, function(exists) {
						if (exists == false) {
							//console.log('Run \'npm start\' to create database structures before running this script.');
							onlyConsole.trace('Run \'npm start\' to create database structures before running this script.');
							exit();
						} else {
							if (cluster.isMaster) {
								var s_timer = new Date().getTime();
								db.update_db(settings.coin, function() {
									numWorkers = 0;
									numWorkersNeeded = 0;
									db.get_stats(settings.coin, function(stats) {
										if (settings.heavy == true) {
											db.update_heavy(settings.coin, stats.count, 20, function() {

											});
										}
                    var highestBlock = stats.count;
										var startAtBlock = stats.last;
										if (mode == 'reindex') {
                      highestBlock = 0;
                      startAtBlock = 1;
											Address.deleteMany({}, function(err2, res1) {
												AddressTx.deleteMany({}, function(err3, res2) {
													Tx.deleteMany({}, function(err4, res3) {
														Richlist.updateOne({
															coin: settings.coin
														}, {
															received: [],
															balance: [],
														}, function(err3) {
															Stats.updateOne({
																coin: settings.coin
															}, {
																last: 0,
															}, function() {
																//console.log('index cleared (reindex)');
                                onlyConsole.trace('index cleared (reindex)');
                                
															});
														});
													});
												});
											});
										}
                    var BlocksToGet = Math.round(stats.count - stats.last);
                    var numThreads = numCPUs;
                    if(BlocksToGet > 0){
                      if (BlocksToGet < MaxPerWorker) {
                        if (BlocksToGet < numThreads) {
                          numThreads = BlocksToGet;
                          numWorkersNeeded = BlocksToGet;
                          MaxPerWorker = 1;
                        } else {
                          numWorkersNeeded = Math.round(BlocksToGet / numThreads);
                          MaxPerWorker = Math.round(BlocksToGet / numThreads);
                        }
                      } else {
                        numWorkersNeeded = Math.round((stats.count - stats.last) / MaxPerWorker);
                      }
                      //console.log("Workers needed: %s. NumThreads: %s. BlocksToGet %s. Per Worker: %s",numWorkersNeeded, numThreads, BlocksToGet, MaxPerWorker, stats.count, stats.last);
                      logger.info("Workers needed: %s. NumThreads: %s. BlocksToGet %s. Per Worker: %s",numWorkersNeeded, numThreads, BlocksToGet, MaxPerWorker, stats.count, stats.last);
                      //exit();
                      //console.log(`Master ${process.pid} is running`);
                      // Fork workers.;
                      for (let i = 0; i < numThreads; i++) {
                        var end = Math.round(startAtBlock + MaxPerWorker) - 1;
                            if(end > stats.count){
                              end = stats.count;
                            }
                        cluster.fork({
                          start: startAtBlock,
                          end: end,
                          wid: i
                        })
                        numWorkers++;
                        numWorkersNeeded = numWorkersNeeded - 1;
                        startAtBlock += Math.round(MaxPerWorker);
                        highestBlock = end;
                      }


                      cluster.on('message', function(worker, msg) {
                        //console.log(`worker ${worker.id} died`);
                        logger.info(`worker ${worker.id} died`);
                        if (msg.msg == "done") {
                          worker.disconnect();
                          //console.log(`worker ${msg.pid} died`);
                          logger.info(`worker ${msg.pid} died`);
                          numWorkersNeeded = numWorkersNeeded - 1;
                          //console.log("There are %s workers still needed", numWorkersNeeded);
                          logger.info("There are %s workers still needed", numWorkersNeeded);
                          if (numWorkersNeeded < 0) {
                            var e_timer = new Date().getTime();
                            db.update_richlist('received', function(){
                              db.update_richlist('balance', function(){
                                db.get_stats(settings.coin, function(nstats){
                                  db.update_cronjob_run(settings.coin,{list_blockchain_update: Math.floor(new Date() / 1000)}, function(cb) {
                                    Tx.countDocuments({}, function(txerr, txcount) {
                                      Address.countDocuments({}, function(aerr, acount) {
                                        Stats.updateOne({coin: coin}, {
                                          last: stats.count
                                        }, function() {});
                                        //console.log('reindex complete (block: %s)', nstats.last);
                                        logger.info('reindex complete (block: %s)', nstats.last);
                                        var stats = {
                                          tx_count: txcount,
                                          address_count: acount,
                                          seconds: (e_timer - s_timer) / 1000,
                                        };
                                        //console.log("Sync had a run time of %s and now has %s transactions and %s acount recorded", stats.seconds.toHHMMSS(), stats.tx_count, stats.address_count);
                                        logger.info("Sync had a run time of %s and now has %s transactions and %s acount recorded", stats.seconds.toHHMMSS(), stats.tx_count, stats.address_count);
                                        exit();
                                      });
                                    });
                                    exit();
                                    });
                                });
                              });
                            });
                          } else {
                            var end = Math.round(startAtBlock + MaxPerWorker) - 1;
                            if(end > stats.count){
                              end = stats.count;
                            }
                            cluster.fork({
                              start: startAtBlock,
                              end: end,
                              wid: numWorkers
                            })
                            numWorkers++;
                            startAtBlock += Math.round(MaxPerWorker);
                            highestBlock = Math.round(startAtBlock + MaxPerWorker) - 1
                          }
                        } else {
                          //console.log('Unknown message:', msg);
                          logger.info('Unknown message:', msg);
                        }
                      });
                    }else{
                      console.log(BlocksToGet);
                      exit();
                    }
                  });
								});
							} else {
                //console.log("Worker [%s] %s is starting, start at index %s and end at index %s", 
                logger.info("Worker [%s] %s is starting, start at index %s and end at index %s", 
                  cluster.worker.process.env['wid'], 
                  cluster.worker.process.pid, 
                  cluster.worker.process.env['start'], 
                  cluster.worker.process.env['end']
                )
								db.update_tx_db(settings.coin, Number(cluster.worker.process.env['start']), Number(cluster.worker.process.env['end']), settings.update_timeout, function() {
									process.send({
										pid: cluster.worker.process.pid,
										wid: cluster.worker.process.pid,
										msg: 'done'
									});
								});
							}
						}
					});
				} else {
					//update markets
					var markets = settings.markets.enabled;
					var complete = 0;
					for (var x = 0; x < markets.length; x++) {
						var market = markets[x];
						db.check_market(market, function(mkt, exists) {
							if (exists) {
								db.update_markets_db(mkt, function(err) {
									if (!err) {
										console.log('%s market data updated successfully.', mkt);
										complete++;
										if (complete == markets.length) {
											db.update_cronjob_run(settings.coin, {
												list_market_update: Math.floor(new Date() / 1000)
											}, function(cb) {
												exit();
											});
										}
									} else {
										console.log('%s: %s', mkt, err);
										complete++;
										if (complete == markets.length) {
											db.update_cronjob_run(settings.coin, {
												list_market_update: Math.floor(new Date() / 1000)
											}, function(cb) {
												exit();
											});
										}
									}
								});
							} else {
								console.log('error: entry for %s does not exists in markets db.', mkt);
								complete++;
								if (complete == markets.length) {
									exit();
								}
							}
						});
					}
				}
			});
		});
	}
});
