///<reference path="../typings/main.d.ts" />

'use strict';

// based on http://findnerd.com/list/view/Two-Phase-commits-in-MongoDB/5965/
import * as async from 'async';
import {expect} from 'chai';
import {Db} from 'mongodb';
import * as mongoose from 'mongoose';

interface ITransaction extends mongoose.Document {
    _id: string;
    source: string;
    destination: string;
    value: number;
    state: string;
    lastModified: Date;
}

let Schema = mongoose.Schema,
    accountSchema = new Schema({
        _id: { type: String, required: true, unique: true },
        balance: Number,
        pendingTransactions: [String]
    }),
    account = mongoose.model('Account', accountSchema),
    transactionSchema = new Schema({
        _id: { type: String, required: true, unique: true },
        source: String,
        destination: String,
        value: Number,
        state: String,
        lastModified: Date
    }),
    transaction = mongoose.model('Transaction', transactionSchema),
    testDb = 'test' + Date.now(),
    testConnString = 'mongodb://localhost/' + testDb;

describe('two phase commit basic test using mongoose', () => {
    before(done => {
        mongoose.connect(testConnString).connection
            .once('connected', done);
    });

    after(done => {
        let db = <Db>mongoose.connection.db;

        if (((<string>db.databaseName || '').indexOf('test') >= 0)) {
            db.dropDatabase(() => mongoose.connection.close(done));
        } else {
            mongoose.connection.close(done);
        }
    });

    describe('test simple two phase commit', () => {
        beforeEach(done => {
            let db = <Db>mongoose.connection.db;

            async.series([
                callback => db.listCollections({}).toArray((err, c) => {
                    async.map(c.filter((e, i) => e['name'].indexOf('system.') === -1), (c, callback) => {
                        db.collection(c['name']).drop(callback);
                    }, callback);
                }),
                callback => {
                    async.parallel([
                        callback => new account({
                            _id: 'A',
                            balance: 1000,
                            pendingTransactions: []
                        }).save(callback),
                        callback => new account({
                            _id: 'B',
                            balance: 1000,
                            pendingTransactions: []
                        }).save(callback)
                    ], callback);
                }
            ], (err, result) => {
                if (err) {
                    throw err;
                }

                done();
            });
        });

        it('should perform a simple two phase commit', done => {
            let t: ITransaction;

            async.series([
                // Initialize Transfer Record
                // Insert records to transaction collection to perform transfer of money
                callback => new transaction({
                    _id: 1,
                    source: 'A',
                    destination: 'B',
                    value: 100,
                    state: 'initial',
                    lastModified: new Date()
                }).save(callback),
                // Transfer Funds Between Accounts Using Two-Phase Commit
                // 1)Retrieve the transaction to start.
                callback => transaction.findOne({ state: 'initial' }, (err, result) => {
                    t = <ITransaction>result;
                    callback();
                }),
                // 2)Update transaction state to pending.
                callback => transaction.findOneAndUpdate({ _id: t._id, state: 'initial' }, {
                    $set: { state: 'pending' },
                    $currentDate: { lastModified: true }
                }, callback),
                // 3)Apply the transaction to both accounts.
                callback => async.parallel([
                    callback => account.findOneAndUpdate({
                        _id: t.source,
                        pendingTransactions: { $ne: t._id }
                    },
                        {
                            $inc: { balance: -t.value },
                            $push: { pendingTransactions: t._id }
                        }, callback),
                    callback => account.findOneAndUpdate({
                        _id: t.destination,
                        pendingTransactions: { $ne: t._id }
                    },
                        {
                            $inc: { balance: t.value },
                            $push: { pendingTransactions: t._id }
                        }, callback)
                ], callback),
                // 4)Update transaction state to applied
                callback => transaction.findOneAndUpdate({ _id: t._id, state: 'pending' }, {
                    $set: { state: 'applied' },
                    $currentDate: { lastModified: true }
                }, callback),
                // 5)Update both accounts’ list of pending transactions
                callback => async.parallel([
                    callback => account.findOneAndUpdate({
                        _id: t.source,
                        pendingTransactions: t._id
                    },
                        {
                            $pull: { pendingTransactions: t._id }
                        }, callback),
                    callback => account.findOneAndUpdate({
                        _id: t.destination,
                        pendingTransactions: t._id
                    },
                        {
                            $pull: { pendingTransactions: t._id }
                        }, callback)
                ], callback),
                // 6)Update transaction state to done.
                callback => transaction.findOneAndUpdate({ _id: t._id, state: 'applied' }, {
                    $set: { state: 'done' },
                    $currentDate: { lastModified: true }
                }, callback),
            ], (err, result) => {
                async.parallel<any>({
                    count: callback => transaction.count({ state: 'done' }, callback),
                    accountA: callback => account.findOne({ _id: 'A' }, callback),
                    accountB: callback => account.findOne({ _id: 'B' }, callback)
                }, (err, result) => {
                    expect(result['count']).to.equal(1);
                    expect(result['accountA'].balance).to.equal(900);
                    expect(result['accountB'].balance).to.equal(1100);
                    expect(result['accountA'].pendingTransactions.length).to.equal(0);
                    expect(result['accountB'].pendingTransactions.length).to.equal(0);
                    done();
                });
            });
        });
    });
});