const fp = require('lodash/fp');
const bigdecimal = require('bigdecimal');
const moment = require('moment');
const schedule = require('node-schedule');
const {formatMysqlDateTime} = Include('/libs/util');

const generateProject = (setting, dailyTo) => async projectId => {
    const dailyFrom = moment(dailyTo).startOf('days').unix();
    const paymentDay = moment(dailyTo).unix();

    return allContracts(MySQL)(projectId, dailyFrom).then(
        contracts => {
            if (!contracts.length) {
                log.info(`no contracts in project ${projectId}`);
                return;
            }
            // console.log('contracts', fp.map(a => a.toJSON())(contracts));
            const houseIds = fp.uniq(fp.compact(
                fp.map(fp.get('room.houseId'))(contracts)));
            // const roomId2ContractId = fp.fromPairs(
            //     fp.map(contract => [contract.roomId, contract.id])(contracts));
            // const roomId2UserId = fp.fromPairs(fp.map(
            //     c => [c.roomId, c.userId])(contracts));

            let houseId2Rooms = {};
            let deviceId2Room = {};
            fp.each(contract => {
                if (!contract.room) {
                    return;
                }
                //todo: 是否合同生效当天就进行计费
                const roomId = contract.room.id;
                const houseId = contract.room.houseId;

                if (!houseId2Rooms[houseId]) {
                    houseId2Rooms[houseId] = [];
                }
                houseId2Rooms[houseId].push(roomId);

                fp.each(device => {
                    deviceId2Room[device.deviceId] = fp.assign({
                        projectId,
                        contractId: contract.id,
                        userId: contract.userId,
                    })(contract.room);
                })(contract.room.devices);

            })(contracts);

            return Promise.all([
                Util.getHouses(projectId, dailyTo, 'CLIENT', houseIds).
                    then(fp.map(a => a.toJSON())),
                MySQL.HouseApportionment.findAll({
                    attributes: ['houseId', 'roomId', 'value'],
                    where: {
                        projectId,
                        houseId: {$in: houseIds},
                    },
                }),
            ]).then(
                ([houses, apportionments]) => {
                    const houseApportionment = houseIdRoomId2Share(
                        apportionments);
                    // console.log('houseApportionment', houseApportionment);
                    // console.log('houses', fp.map(a => a.toJSON())(houses));

                    const deviceId2ElectricityPrice = devicesWithItsPrice(
                        houses);
                    const deviceIdDic = houseIdOfDevices(houses);
                    const allDeviceIds2 = allDeviceIds(houses);

                    const getAmountAndPrice = (cost) => {
                        const price = priceOfHouse(
                            deviceIdDic, deviceId2ElectricityPrice)(
                            cost.deviceId);
                        return costOfRoom(price, cost);
                    };
                    const getApportionment = houseId => {
                        const apportionment = houseApportionment[houseId];
                        return apportionment ?
                            apportionment :
                            Util.autoApportionment(houseId2Rooms[houseId]);
                    };
                    // console.log('heartbeatInProject: ', dailyFrom,
                    //     dailyTo.unix(), projectId);
                    return heartbeatInProject(MySQL)(dailyFrom, dailyTo.unix(),
                        projectId).then(
                        heartbeats => {
                            // console.log('houseCostMapping', houseCostMapping);
                            fp.each(costs => {
                                // console.log('costs', costs);
                                fp.each(cost => {
                                    //
                                    const amountAndPrice = getAmountAndPrice(
                                        cost);
                                    const room = deviceId2Room[cost.deviceId];

                                    if (cost.public) {
                                        //公区表
                                        const apportionments = fp.toPairs(
                                            getApportionment(cost.houseId));
                                        fp.each(([, percent]) => {
                                            payDevice(MySQL)({
                                                type: 'ELECTRICITY',
                                                contractId: room.contractId,
                                                projectId,
                                                deviceId: cost.deviceId,
                                                amount: -calcShare(
                                                    amountAndPrice, percent),
                                                scale: scaleOf(cost),
                                                usage: usageOf(cost),
                                                price: amountAndPrice.price,
                                                share: percent,
                                                paymentDay,
                                                createdAt: moment().unix(),
                                            }, room);
                                        })(apportionments);
                                    }
                                    else {
                                        //私有表
                                        payDevice(MySQL)({
                                            type: 'ELECTRICITY',
                                            contractId: room.contractId,
                                            projectId,
                                            deviceId: cost.deviceId,
                                            amount: -amountAndPrice.amount,
                                            scale: scaleOf(cost),
                                            usage: usageOf(cost),
                                            price: amountAndPrice.price,
                                            paymentDay,
                                            createdAt: moment().unix(),
                                        }, room);
                                    }

                                })(costs);
                            })(devicesWithHeartbeats(allDeviceIds2,
                                heartbeats));

                        },
                    );
                },
            );
        },
    ).catch(err => {
        log.error(
            `error ${err} in calculating: ${projectId} at time ${dailyTo}`);
    });
};

const generate = (settings, endTime) =>
    projects =>
        Promise.all(
            fp.map(fp.pipe(fp.get('id'), generateProject(settings, endTime)))(
                projects)).
            then(() => log.warn('DeviceDailyBills Done...'));

exports.bill = (endTime) => Promise.all([
    MySQL.Settings.findAll({}),
    MySQL.Projects.findAll({attributes: ['id']}),
]).then(([settingRecords, projects]) => {
    const setting = fp.fromPairs(
        fp.map(setting => [setting.id, setting])(settingRecords));
    return generate(setting, endTime)(projects);
},
);

const devicesWithHeartbeats = (devicesWithPrice, heartbeats) => {
    const uniqueDeviceIdsFromHeartbeats = fp.flatten(
        fp.map(v => ({deviceId: v}))(
            fp.keys(heartbeats)));
    const deviceInDifference = fp.differenceBy(
        fp.pipe(fp.get('deviceId'), dId => dId.toString()))(devicesWithPrice)(
        uniqueDeviceIdsFromHeartbeats);
    const defaultTemplates = fp.groupBy('deviceId')(
        fp.map(fp.defaults({startScale: 0, endScale: 0}))(
            deviceInDifference));
    return fp.defaults(defaultTemplates)(heartbeats);
};

const payDevice = MySQL => async (devicePrePaid, room) => {
    console.log('payDevice', devicePrePaid, room);
    const {userId, id: roomId, projectId} = room;
    const flowId = Util.newId();
    const prePaidObj = fp.assign(devicePrePaid,
        {id: Util.newId(), flowId: flowId});

    const prePaidFlow = {
        id: flowId,
        projectId,
        contractId: devicePrePaid.contractId,
        paymentDay: devicePrePaid.paymentDay,
        category: 'device',
    };

    log.info('devicePrePaid: ', userId, prePaidObj,
        prePaidFlow);

    return Util.PayWithOwed(userId, prePaidObj.amount).then(
        ret => {
            if (ret.code !== ErrorCode.OK) {
                log.error('PayWithOwed failed', userId,
                    prePaidObj, roomId, ret);
                return;
            }

            return Promise.all([
                MySQL.DevicePrePaid.create(prePaidObj),
                MySQL.PrePaidFlows.create(prePaidFlow)]).
                then(() => Message.BalanceChange(projectId, userId,
                    ret.amount,
                    ret.balance));
        },
    );
};

const usageOf = cost => (cost.endScale - cost.startScale) * 10000;
const scaleOf = cost => cost.endScale * 10000;
const heartbeatInProject = MySQL => async (timeFrom, timeTo, projectId) => {
    const groupingData = await MySQL.DeviceHeartbeats.findAll(
        {
            attributes: [
                'deviceId',
                [
                    MySQL.Sequelize.fn('max',
                        MySQL.Sequelize.col('total')), 'endScale'],
                [
                    MySQL.Sequelize.fn('min',
                        MySQL.Sequelize.col('total')), 'startScale']],
            group: ['deviceId'],
            where: {
                createdAt: {
                    $gte: formatMysqlDateTime(timeFrom),
                    $lte: formatMysqlDateTime(timeTo),
                },
            },
            include: [
                {
                    model: MySQL.HouseDevices,
                    required: true,
                    where: {
                        projectId,
                        endDate: 0,
                    },
                    attributes: ['projectId'],
                }],
        },
    );
    return fp.groupBy('deviceId')(fp.map(
        data => ({...data.toJSON(), startDate: timeFrom, endDate: timeTo}))(
        groupingData));
};

const allContracts = MySQL => async (
    projectId, dailyFrom) => MySQL.Contracts.findAll({
    where: {
        projectId,
        status: 'ONGOING',
    },
    attributes: ['id', 'roomId', 'userId', 'expenses'],
    include: [
        {
            model: MySQL.Rooms,
            as: 'room',
            include: [
                {
                    model: MySQL.HouseDevices,
                    as: 'devices',
                    where: {
                        endDate: {
                            $or: [
                                {$eq: 0},
                                {$gte: dailyFrom},
                            ],
                        },
                    },
                    required: true,
                },
            ],
            required: true,
        },
    ],
});

const calcShare = (amountAndPrice, percent) => (
    new bigdecimal.BigDecimal(amountAndPrice.amount.toString())
).multiply(new bigdecimal.BigDecimal(percent.toString()),
).
    divide(new bigdecimal.BigDecimal('100'), 0,
        bigdecimal.RoundingMode.HALF_UP()).
    intValue();

const costOfRoom = (price, cost) => {
    const amount = amountOf(cost.endScale - cost.startScale, price);
    return {
        amount,
        price,
    };
};

const amountOf = (base, price) => {
    const baseBd = new bigdecimal.BigDecimal(base.toString());
    const priceBd = new bigdecimal.BigDecimal(price.toString());
    return baseBd.multiply(priceBd);
};

const priceOfHouse = (houseDictionary, deviceId2ElectricityPrice) =>
    deviceId => {
        const house = houseDictionary(deviceId);
        return fp.getOr(0)(house.id)(deviceId2ElectricityPrice);
    };

const houseIdRoomId2Share = apportionments =>
    fp.mapValues(
        fp.pipe(fp.groupBy('roomId'),
            fp.mapValues(fp.pipe(fp.head, fp.get('value')))))(
        fp.groupBy('houseId')(
            fp.map(a => a.toJSON())(apportionments)));

const houseIdOfDevices = houses => deviceId => fp.find(house => {
    const devices = fp.flatten(
        [house.devices, fp.flatten(fp.map('devices')(house.rooms))]);
    return fp.any(fp.pipe(fp.get('deviceId'), fp.eq(deviceId)))(
        devices);
})(houses);

const allDeviceIds = houses => fp.flatten(fp.map(house => fp.flatten(
    [house.devices, fp.flatten(fp.map('devices')(house.rooms))]))(houses));

const devicesWithItsPrice = houses => {
    return fp.mapValues(
        fp.pipe(fp.head, fp.get('prices'),
            fp.find(fp.pipe(fp.get('type'), fp.eq('ELECTRIC'))),
            fp.getOr(0)('price')))(
        fp.groupBy('id')(fp.map(fp.pick(['id', 'prices']))(
            houses)));
};

exports.Run = () => {
    const rule = new schedule.RecurrenceRule();
    rule.hour = 3;
    rule.minute = 30;
    // rule.second = 5;
    schedule.scheduleJob(rule, async () => {
        console.log(
            `Daily backend process for device daily bills, start from ${moment().
                format('YYYY-MM-DD hh:mm:ss')}`);
        return exports.bill(moment().subtract(1, 'day').endOf('day'));
    });
};

exports.ModuleName = 'DeviceDailyBills';
