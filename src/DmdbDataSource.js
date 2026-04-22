"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DmdbDataSource = void 0;
const typeorm_1 = require("typeorm");
const DmdbDriver_1 = require("./DmdbDriver");
const DmdbInsertQueryBuilder_1 = require("./DmdbInsertQueryBuilder");
class DmdbDataSource extends typeorm_1.DataSource {
    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------
    constructor(options) {
        Object.assign(options, { driver: require("dmdb") });
        super(options);
        this.driver = new DmdbDriver_1.DmdbDriver(this);
        typeorm_1.QueryBuilder.registerQueryBuilderClass("InsertQueryBuilder", (qb) => new DmdbInsertQueryBuilder_1.DmdbInsertQueryBuilder(qb));
    }
}
exports.DmdbDataSource = DmdbDataSource;
