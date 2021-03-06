const fp = require('lodash/fp');
const moment = require('moment');
const schedule = require('node-schedule');

const innerValue = j => j.toJSON();
const extractPrepaid = contract => {
    const filtered = fp.filter(
        expense => expense.configId !== 1041 && expense.pattern === 'prepaid')(
        contract.expenses);
    return fp.map(fp.defaults(fp.pick(['userId', 'id'])(contract)))(filtered);
};
const generateProject = dailyTo => async projectId => {
    const dailyFrom = moment(dailyTo).startOf('days').unix();
    const paymentDay = moment(dailyTo).unix();

    return allContracts(MySQL)(projectId, dailyFrom).
        then(fp.map(innerValue)).
        then(
            contracts => {
                if (!contracts.length) {
                    log.info(`no contracts in project ${projectId}`);
                    return;
                }
                return fp.map(
                    fp.pipe(extractPrepaid,
                        fp.map(prepaidRecord(projectId, paymentDay))),
                )(contracts);
            },
        ).catch(err => {
            log.error(
                `error ${err} in calculating: ${projectId} at time ${dailyTo}`);
        });
};

const prepaidRecord = (projectId, paymentDay) => async prepaidObject => {
    const flowId = Util.newId();
    const {id: contractId, userId, rent, configId, roomId} = prepaidObject;
    const prePaidObj = {
        configId, contractId, projectId, id: Util.newId(),
        flowId, amount: -rent, createdAt: moment().unix(), paymentDay,
    };

    return Util.PayWithOwed(userId, prePaidObj.amount).then(
        ret => {
            if (ret.code !== ErrorCode.OK) {
                log.error('PayWithOwed in daily prepaid failed', userId,
                    prePaidObj, roomId, ret);
                return;
            }

            const prePaidFlow = {
                projectId,
                id: flowId,
                contractId,
                paymentDay,
                category: 'daily',
                amount: fp.getOr(0)('result.amount')(ret),
                balance: fp.getOr(0)('result.balance')(ret),
                createdAt: prePaidObj.createdAt,
            };

            return Promise.all([
                MySQL.DailyPrepaid.create(prePaidObj),
                MySQL.PrepaidFlows.create(prePaidFlow)]).
                then(() => Message.BalanceChange(projectId, userId,
                    ret.amount,
                    ret.balance));
        },
    );
};

const allContracts = MySQL => async (
    projectId) => MySQL.Contracts.findAll({
    where: {
        projectId,
        status: 'ONGOING',
        //TODO: consider dailyFrom
    },
    attributes: ['id', 'roomId', 'userId', 'expenses'],
});

const generate = endTime =>
    projects =>
        Promise.all(
            fp.map(fp.pipe(fp.get('id'), generateProject(endTime)))(
                projects)).
            then(() => log.warn('DailyPrepaid Done...'));

exports.deduct = endTime => MySQL.Projects.findAll({attributes: ['id']}).
    then(generate(endTime));

exports.Run = () => {
    const rule = new schedule.RecurrenceRule();
    rule.hour = 8;
    rule.minute = 0;
    // rule.second = 5;
    schedule.scheduleJob(rule, async () => {
        console.log(
            `Daily backend process for prepaid deduction, start from ${moment().
                format('YYYY-MM-DD hh:mm:ss')}`);
        return exports.deduct(moment().subtract(1, 'day').endOf('day'));
    });
};

exports.ModuleName = 'DailyPrepaid';
