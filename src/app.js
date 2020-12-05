require('dotenv').config();
const { ApiPromise, WsProvider } = require('@polkadot/api');
const { cryptoWaitReady, encodeAddress } = require('@polkadot/util-crypto');
const types = require('../config/typedefs.json');
const Decimal = require('decimal.js');
const Seedrandom = require('seedrandom');
const BN = require('bn.js');
const fs = require('fs');
const path = require('path');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function readJson(filePath) {
    return new Promise((resolve,reject)=>{
        fs.readFile(filePath,'utf8',(err, data)=>{
            if(err) throw err;
            resolve(JSON.parse(data));
        })
    })
}

function writeJson(filePath, data) {
    return new Promise((resolve,reject)=>{
        fs.writeFile(filePath, data,(err)=>{
            if(err) throw err;
            console.log('file：' + filePath);
            resolve();
        })
    })
}

function mapToJson(map) {
    return JSON.stringify([...map]);
}

function jsonToMap(jsonStr) {
    return new Map(JSON.parse(jsonStr));
}

function getRandomNum(n, total, hash) {
    let rng = new Seedrandom(hash);
    let set = new Set();
    while(set.size < n-1) {
        const i = Math.floor(rng() * total);
        if(i > 0 && i < total && !set.has(i)) {
            set.add(i);
        }
    }
    const setArray = Array.from(set);
    setArray.sort(function (a, b) {
        return b - a
    });
    const len = setArray.length;
    let res = [];
    res.push(total - setArray[0]);
    for (let i = 1; i < len; i++) {
        res.push(setArray[i-1] - setArray[i]);
    }
    res.push(setArray[len-1]);
    return res;
}

function getRandomLotteryPoolMap(lotteryPool, hash) {
    let rng = new Seedrandom(hash);
    let set = new Set();
    let size = lotteryPool.size;
    let lotteryPoolArray = Array.from(lotteryPool.keys());
    let limit = Math.floor(size * 0.05);
    while(set.size < limit) {
        const i = Math.floor(rng() * size);
        if(i > 0 && i < size && !set.has(i)) {
            set.add(i);
        }
    }
    const setArray = Array.from(set);
    setArray.sort(function (a, b) {
        return a - b
    });
    let res = new Map();
    for (let i = 0; i < limit; i++) {
        res.set(lotteryPoolArray[setArray[i]], 0);
    }
    return res;
}

function toPercent(point){
    let str=Number(point*100).toFixed(2);
    str+="%";
    return str;
}

const worker = async () => {
    const wsEndPoint = process.env.END_POINT;
    const wsProvider = new WsProvider(wsEndPoint);
    const api = await ApiPromise.create({provider: wsProvider, types});
    await cryptoWaitReady();
    while (true) {
        try {
            /**
             * get local round data: localRound, onlineTimeMap, totalPowerMap
             **/
            const roundFile = path.join(__dirname, '../data/round.json');
            const roundFileData = await readJson(roundFile);
            const localRound = roundFileData['round'];
            let lotteryStatus = roundFileData['lotteryStatus'];
            let onlineTimeMap = new Map();
            let totalPowerMap = new Map();
            if(localRound !== 0)  {
                onlineTimeMap = new Map(jsonToMap(roundFileData['onlineTimeMap']));
                // console.log('onlineTimeMap', onlineTimeMap);
                totalPowerMap = new Map(jsonToMap(roundFileData['totalPowerMap']));
                // console.log('totalPowerMap', totalPowerMap);
            }

            /**
             * get online round data: onlineRound, onlineStartBlock
             **/
            const lastHeader = await api.rpc.chain.getHeader();
            const lastHeaderNumber = parseInt(lastHeader.number.toString());
            console.log("lastHeader #", lastHeaderNumber);
            const lastHeaderHash = lastHeader.hash.toString();
            const onlineRoundData = await api.query.phalaModule.round.at(lastHeaderHash);
            const onlineRound = parseInt(onlineRoundData['round'].toString());
            const onlineStartBlock = parseInt(onlineRoundData['startBlock'].toString());

            /**
             * supplement roundMap and totalPowerMap
             **/
            let roundMap = new Map();
            if (onlineRound > localRound) {
                let tBlock = onlineStartBlock - 5;
                for (let r = onlineRound - 1; r >= localRound; r--) {
                    const tBlockHash = await api.rpc.chain.getBlockHash(tBlock);
                    const tRoundData = await api.query.phalaModule.round.at(tBlockHash);
                    const tStartBlock = parseInt(tRoundData['startBlock'].toString());
                    //console.log(tBlockHash.toString(), tStartBlock);
                    roundMap.set(r, tStartBlock);
                    const totalPowerData = await api.query.phalaModule.totalPower.at(tBlockHash);
                    const totalPower = parseInt(totalPowerData.toString());
                    totalPowerMap.set(r, totalPower);
                    tBlock = tStartBlock - 5;
                }
            }
            // console.log("totalPowerMap", totalPowerMap);
            // console.log("roundMap ", roundMap);

            /**
             * get result data: targetAddressFireMap, targetAddressStateMap, lotteryPool
             **/
            const stashStateMap = await api.query.phalaModule.stashState.keysAt(lastHeaderHash);
            const stashAccounts = stashStateMap.map(({args: [accountId]}) => accountId);
            let targetAddressFireMap = new Map();
            let targetAddressStateMap = new Map();
            let lotteryPool = new Map();
            if (stashAccounts && stashAccounts.length > 0) {
                const len = stashAccounts.length;
                for (let i = 0; i < len; i++) {
                    const workerState = await api.query.phalaModule.workerState.at(lastHeaderHash, stashAccounts[i]);
                    // console.log("score", workerState['score'].toJSON());
                    if (workerState['score'].toJSON() !== null) {
                        const stashState = await api.query.phalaModule.stashState.at(lastHeaderHash, stashAccounts[i]);
                        const stashAddress = encodeAddress(stashAccounts[i], 30);
                        const controllerAddress = encodeAddress(stashState['controller'], 30);
                        const overallScore = workerState['score'].toJSON()['overallScore'];
                        for (let r = localRound; r < onlineRound; r++) {
                            const tStartBlock = roundMap.get(r);
                            const tBlockHash = await api.rpc.chain.getBlockHash(tStartBlock);
                            const tWorkerState = await api.query.phalaModule.workerState.at(tBlockHash, stashAccounts[i]);
                            const tState = tWorkerState['state'].toJSON();
                            if (onlineTimeMap.has(stashAddress)) {
                                if (tState.hasOwnProperty('Mining')) {
                                    // console.log("tState: ", tState);
                                    onlineTimeMap.set(stashAddress, onlineTimeMap.get(stashAddress) + 1);
                                }
                            } else {
                                if (tState.hasOwnProperty('Mining')) {
                                    onlineTimeMap.set(stashAddress, 1);
                                } else {
                                    onlineTimeMap.set(stashAddress, 0);
                                }
                            }
                        }
                        // console.log("onlineTimeMap", onlineTimeMap);
                        let onlineTime = onlineTimeMap.get(stashAddress);
                        const stashAddressState = {
                            "controller": controllerAddress,
                            "overallScore": overallScore,
                            "onlineTime": onlineTime
                        }
                        // console.log("stashAddressState", stashAddressState);
                        const targetAddress = encodeAddress(stashState['payoutPrefs'].toJSON()['target'], 30);
                        const stashAddressWithState = {"stashAddress": stashAddress, "stashState": stashAddressState};
                        // console.log("stashAddressWithState", stashAddressWithState);
                        if (targetAddressStateMap.has(targetAddress)) {
                            const stashAddressWithStateArray = JSON.parse(targetAddressStateMap.get(targetAddress));
                            stashAddressWithStateArray.push(stashAddressWithState);
                            targetAddressStateMap.set(targetAddress, JSON.stringify(stashAddressWithStateArray));
                        } else {
                            targetAddressStateMap.set(targetAddress, JSON.stringify([stashAddressWithState]));
                        }
                        const fireData = await api.query.phalaModule.fire.at(lastHeaderHash, targetAddress);
                        const fire = new BN(fireData.toString(), 10);
                        targetAddressFireMap.set(targetAddress, fire.toString());

                        const timeLimit = parseInt(process.env.TIME_LIMIT);
                        if(onlineTimeMap.get(stashAddress) > timeLimit && !lotteryPool.has(stashAddress)) {
                            lotteryPool.set(stashAddress, 0);
                        }
                    }
                }
            }

            /**
             * sort dashboard by fire amount
             **/
            const targetAddressFireArray = Array.from(targetAddressFireMap);
            targetAddressFireArray.sort(function (a, b) {
                return b[1] - a[1];
            });
            const len = targetAddressFireArray.length;
            let dashboardArray = [];
            const totalFireData= await api.query.phalaModule.accumulatedFire.at(lastHeaderHash);
            const totalFire = new Decimal(totalFireData.toString());

            for (let i = 0; i < len; i++) {
                const targetAddress = targetAddressFireArray[i][0];
                const targetFire = new Decimal(targetAddressFireMap.get(targetAddress));

                let targetFireRatio = 0.0;
                if(totalFireData.toString() !== '0') {
                    targetFireRatio = targetFire.div(totalFire).toNumber();
                }
                // console.log("targetFire", targetFire.toString());
                // console.log("totalFire", totalFire.toString());
                // console.log("targetFireRatio", targetFireRatio);

                const targetDashboard = {
                    "targetAddress": targetAddress,
                    "targetFire": targetFire.toString(),
                    "targetFireRatio": toPercent(targetFireRatio),
                    "targetState": JSON.parse(targetAddressStateMap.get(targetAddress)),
                };
                dashboardArray.push(targetDashboard);
            }

            /**
             * generate and save lotteryPool
             **/
            const totalPowerData = await api.query.phalaModule.totalPower.at(lastHeaderHash);
            const totalPower = parseInt(totalPowerData);
            const goalPower1 = parseInt(process.env.GOAL_POWER1);
            const goalPower2 = parseInt(process.env.GOAL_POWER2);
            const goalPower3 = parseInt(process.env.GOAL_POWER3);

            if (totalPower > goalPower1 && totalPower < goalPower2 && lotteryStatus === 0 && lotteryPool.size > 0) {
                lotteryStatus = 1;
                const newLotteryPool = getRandomLotteryPoolMap(lotteryPool, lastHeaderHash)
                const randomArray = getRandomNum(newLotteryPool.size, 720000, lastHeaderHash);
                let index = 0;
                for (let key of newLotteryPool.keys()) {
                    newLotteryPool.set(key, randomArray[index++]);
                }
                const lotteryFile = path.join(__dirname, '../data/lottery1.json');
                const lotteryPoolJson = mapToJson(newLotteryPool);
                await writeJson(lotteryFile, JSON.stringify(lotteryPoolJson));
                const lotteryBlockFile = path.join(__dirname, '../data/lottery1Block.json');
                const blockInfo = {blockNum:lastHeaderNumber, blockHash: lastHeaderHash}
                await writeJson(lotteryBlockFile, JSON.stringify(blockInfo));
            }

            if (totalPower > goalPower2 && totalPower < goalPower3 && lotteryStatus === 1 && lotteryPool.size > 0) {
                lotteryStatus = 2;
                const newLotteryPool = getRandomLotteryPoolMap(lotteryPool, lastHeaderHash)
                const randomArray = getRandomNum(newLotteryPool.size, 720000, lastHeaderHash);
                let index = 0;
                for (let key of newLotteryPool.keys()) {
                    newLotteryPool.set(key, randomArray[index++]);
                }
                const lotteryFile = path.join(__dirname, '../data/lottery2.json');
                const lotteryPoolJson = mapToJson(newLotteryPool);
                await writeJson(lotteryFile, JSON.stringify(lotteryPoolJson));
                const lotteryBlockFile = path.join(__dirname, '../data/lottery2Block.json');
                const blockInfo = {blockNum:lastHeaderNumber, blockHash: lastHeaderHash}
                await writeJson(lotteryBlockFile, JSON.stringify(blockInfo));
            }

            if (totalPower > goalPower3 && lotteryStatus === 2 && lotteryPool.size > 0) {
                lotteryStatus = 2;
                const newLotteryPool = getRandomLotteryPoolMap(lotteryPool, lastHeaderHash)
                const randomArray = getRandomNum(newLotteryPool.size, 720000, lastHeaderHash);
                let index = 0;
                for (let key of newLotteryPool.keys()) {
                    newLotteryPool.set(key, randomArray[index++]);
                }
                const lotteryFile = path.join(__dirname, '../data/lottery3.json');
                const lotteryPoolJson = mapToJson(newLotteryPool);
                await writeJson(lotteryFile, JSON.stringify(lotteryPoolJson));
                const lotteryBlockFile = path.join(__dirname, '../data/lottery3Block.json');
                const blockInfo = {blockNum:lastHeaderNumber, blockHash: lastHeaderHash}
                await writeJson(lotteryBlockFile, JSON.stringify(blockInfo));
            }

            let resultLotteryPool1 = new Map();
            let resultLotteryPool2 = new Map();
            let resultLotteryPool3 = new Map();

            if(lotteryStatus === 1) {
                const lottery1File = path.join(__dirname, '../data/lottery1.json');
                const resultLotteryPool1Json = await readJson(lottery1File);
                resultLotteryPool1 = jsonToMap(resultLotteryPool1Json);
            }

            if(lotteryStatus === 2) {
                const lottery1File = path.join(__dirname, '../data/lottery1.json');
                const resultLotteryPool1Json = await readJson(lottery1File);
                resultLotteryPool1 = jsonToMap(resultLotteryPool1Json);
                const lottery2File = path.join(__dirname, '../data/lottery2.json');
                const resultLotteryPool2Json = await readJson(lottery2File);
                resultLotteryPool2 = jsonToMap(resultLotteryPool2Json);
            }

            if(lotteryStatus === 3) {
                const lottery1File = path.join(__dirname, '../data/lottery1.json');
                const resultLotteryPool1Json = await readJson(lottery1File);
                resultLotteryPool1 = jsonToMap(resultLotteryPool1Json);
                const lottery2File = path.join(__dirname, '../data/lottery2.json');
                const resultLotteryPool2Json = await readJson(lottery2File);
                resultLotteryPool2 = jsonToMap(resultLotteryPool2Json);
                const lottery3File = path.join(__dirname, '../data/lottery3.json');
                const resultLotteryPool3Json = await readJson(lottery3File);
                resultLotteryPool3 = jsonToMap(resultLotteryPool3Json);
            }

            let maxTotalPower= 0;
            for (let value of totalPowerMap.values()) {
                if (value > maxTotalPower) {
                    maxTotalPower = value;
                }
            }

            /**
             * save result and round
             **/
            const onlineTimeMapJson = mapToJson(onlineTimeMap);
            const totalPowerMapJson = mapToJson(totalPowerMap);
            const lotteryPool1Json = mapToJson(resultLotteryPool1);
            const lotteryPool2Json = mapToJson(resultLotteryPool2);
            const lotteryPool3Json = mapToJson(resultLotteryPool3);

            const saveResultFile = path.join(__dirname, '../data/result.json');
            const timestamp = new Date().getTime();
            const result = {"round": onlineRound, "timestamp":timestamp, "dashboard": dashboardArray, "maxTotalPower": maxTotalPower, "currentTotalPower": totalPower, "lotteryPool1": lotteryPool1Json, "lotteryPool2": lotteryPool2Json, "lotteryPool3": lotteryPool3Json, "onlineTimeMap": onlineTimeMapJson};
            await writeJson(saveResultFile, JSON.stringify(result));

            const saveRoundFile = path.join(__dirname, '../data/round.json');
            const roundInfo = {"round": onlineRound, "startBlock": onlineStartBlock, "lotteryStatus": lotteryStatus, "totalPowerMap": totalPowerMapJson, "onlineTimeMap": onlineTimeMapJson};
            await writeJson(saveRoundFile, JSON.stringify(roundInfo));
            console.log("############### ROUND " + onlineRound + "###############")
            await sleep(6000);
        } catch (e) {
            console.log(e.message);
            break;
        }
    }
}

worker();
