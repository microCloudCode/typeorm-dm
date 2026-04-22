"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DmdbQueryRunner = void 0;
const QueryResult_1 = require("typeorm/query-runner/QueryResult");
const TransactionNotStartedError_1 = require("typeorm/error/TransactionNotStartedError");
const TableColumn_1 = require("typeorm/schema-builder/table/TableColumn");
const Table_1 = require("typeorm/schema-builder/table/Table");
const TableForeignKey_1 = require("typeorm/schema-builder/table/TableForeignKey");
const TableIndex_1 = require("typeorm/schema-builder/table/TableIndex");
const QueryRunnerAlreadyReleasedError_1 = require("typeorm/error/QueryRunnerAlreadyReleasedError");
const View_1 = require("typeorm/schema-builder/view/View");
const Query_1 = require("typeorm/driver/Query");
const OrmUtils_1 = require("typeorm/util/OrmUtils");
const QueryFailedError_1 = require("typeorm/error/QueryFailedError");
const TableUnique_1 = require("typeorm/schema-builder/table/TableUnique");
const BaseQueryRunner_1 = require("typeorm/query-runner/BaseQueryRunner");
const Broadcaster_1 = require("typeorm/subscriber/Broadcaster");
const TableCheck_1 = require("typeorm/schema-builder/table/TableCheck");
const TypeORMError_1 = require("typeorm/error/TypeORMError");
const MetadataTableType_1 = require("typeorm/driver/types/MetadataTableType");
const InstanceChecker_1 = require("typeorm/util/InstanceChecker");
const BroadcasterResult_1 = require("typeorm/subscriber/BroadcasterResult");
/**
 * Runs queries on a single dmdb database connection.
 */
class DmdbQueryRunner extends BaseQueryRunner_1.BaseQueryRunner {
    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------
    constructor(driver, mode) {
        super();
        this.driver = driver;
        this.connection = driver.connection;
        this.broadcaster = new Broadcaster_1.Broadcaster(this);
        this.mode = mode;
    }
    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------
    /**
     * Creates/uses database connection from the connection pool to perform further operations.
     * Returns obtained database connection.
     */
    connect() {
        if (this.databaseConnection)
            return Promise.resolve(this.databaseConnection);
        if (this.databaseConnectionPromise)
            return this.databaseConnectionPromise;
        if (this.mode === "slave" && this.driver.isReplicated) {
            this.databaseConnectionPromise = this.driver
                .obtainSlaveConnection()
                .then((connection) => {
                this.databaseConnection = connection;
                return this.databaseConnection;
            });
        }
        else {
            // master
            this.databaseConnectionPromise = this.driver
                .obtainMasterConnection()
                .then((connection) => {
                this.databaseConnection = connection;
                return this.databaseConnection;
            });
        }
        return this.databaseConnectionPromise;
    }
    /**
     * Releases used database connection.
     * You cannot use query runner methods once its released.
     */
    async release() {
        this.isReleased = true;
        if (!this.databaseConnection) {
            return;
        }
        await this.databaseConnection.close();
    }
    /**
     * Starts transaction on the current connection.
     */
    async startTransaction(isolationLevel) {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError_1.QueryRunnerAlreadyReleasedError();
        if (isolationLevel &&
            isolationLevel != "READ COMMITTED" &&
            isolationLevel != "READ UNCOMMITTED" &&
            isolationLevel != "SERIALIZABLE") {
            throw new TypeORMError_1.TypeORMError(`Dameng only supports READ COMMITTED, READ UNCOMMITTED and SERIALIZABLE isolation`);
        }
        this.isTransactionActive = true;
        try {
            await this.broadcaster.broadcast("BeforeTransactionStart");
            // 事务开始，禁止自动提交（在事务提交和回滚时，会恢复原值）
            // await this.resetAutoCommit(false)
        }
        catch (err) {
            this.isTransactionActive = false;
            throw err;
        }
        if (this.transactionDepth === 0) {
            this.transactionDepth += 1;
            await this.query("ROLLBACK");
            if (isolationLevel) {
                await this.query("SET TRANSACTION ISOLATION LEVEL " + isolationLevel);
            }
        }
        else {
            this.transactionDepth += 1;
            await this.query(`SAVEPOINT typeorm_${this.transactionDepth - 1}`);
        }
        await this.broadcaster.broadcast("AfterTransactionStart");
    }
    /**
     * Commits transaction.
     * Error will be thrown if transaction was not started.
     */
    async commitTransaction() {
        if (!this.isTransactionActive)
            throw new TransactionNotStartedError_1.TransactionNotStartedError();
        await this.broadcaster.broadcast("BeforeTransactionCommit");
        if (this.transactionDepth === 1) {
            await this.query("COMMIT");
            this.isTransactionActive = false;
            // await this.resetAutoCommit()
        }
        this.transactionDepth -= 1;
        await this.broadcaster.broadcast("AfterTransactionCommit");
    }
    /**
     * Rollbacks transaction.
     * Error will be thrown if transaction was not started.
     */
    async rollbackTransaction() {
        if (!this.isTransactionActive)
            throw new TransactionNotStartedError_1.TransactionNotStartedError();
        await this.broadcaster.broadcast("BeforeTransactionRollback");
        if (this.transactionDepth > 1) {
            this.transactionDepth -= 1;
            await this.query(`ROLLBACK TO SAVEPOINT typeorm_${this.transactionDepth}`);
        }
        else {
            this.transactionDepth -= 1;
            await this.query("ROLLBACK");
            this.isTransactionActive = false;
            // await this.resetAutoCommit()
        }
        await this.broadcaster.broadcast("AfterTransactionRollback");
    }
    // private async resetAutoCommit(autoCommit?: boolean) {
    //     const connection = await this.connect()
    //     const currentAutoCommit = <boolean>connection.conn_prop_autoCommit
    //     if (autoCommit === undefined) {
    //         autoCommit = connection.props.getBoolean("autoCommit", this.driver.dmdb.autoCommit);
    //     }
    //     if (autoCommit !== currentAutoCommit) {
    //         connection.conn_prop_autoCommit = autoCommit
    //     }
    // }
    /**
     * Executes a raw SQL query.
     */
    async query(query, parameters, useStructuredResult = false) {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError_1.QueryRunnerAlreadyReleasedError();
        const broadcasterResult = new BroadcasterResult_1.BroadcasterResult();
        try {
            const databaseConnection = await this.connect();
            this.driver.connection.logger.logQuery(query, parameters, this);
            this.broadcaster.broadcastBeforeQueryEvent(broadcasterResult, query, parameters);
            const queryStartTime = +new Date();
            const executionOptions = {
                autoCommit: !this.isTransactionActive,
                outFormat: this.driver.dmdb.OUT_FORMAT_OBJECT,
            };
            const raw = await databaseConnection.execute(query, parameters || {}, executionOptions);
            // dameng modfy: oralce中outBinds是二维数组（第二维其实也只有一个元素），dameng中是一维数组
            if (raw?.hasOwnProperty("outBinds") &&
                Array.isArray(raw.outBinds)) {
                // 在ReturningResultsEntityUpdator.insert()中，会脱一次
                raw.outBinds = raw.outBinds.map((outBind) => [outBind]);
            }
            // log slow queries if maxQueryExecution time is set
            const maxQueryExecutionTime = this.driver.options.maxQueryExecutionTime;
            const queryEndTime = +new Date();
            const queryExecutionTime = queryEndTime - queryStartTime;
            if (maxQueryExecutionTime &&
                queryExecutionTime > maxQueryExecutionTime)
                this.driver.connection.logger.logQuerySlow(queryExecutionTime, query, parameters, this);
            this.broadcaster.broadcastAfterQueryEvent(broadcasterResult, query, parameters, true, queryExecutionTime, raw, undefined);
            const result = new QueryResult_1.QueryResult();
            result.raw =
                raw.rows ||
                    raw.outBinds ||
                    raw.rowsAffected ||
                    raw.implicitResults;
            if (raw?.hasOwnProperty("rows") && Array.isArray(raw.rows)) {
                result.records = raw.rows;
            }
            if (raw?.hasOwnProperty("outBinds") &&
                Array.isArray(raw.outBinds)) {
                result.records = raw.outBinds;
            }
            if (raw?.hasOwnProperty("implicitResults") &&
                Array.isArray(raw.implicitResults)) {
                result.records = raw.implicitResults;
            }
            if (raw?.hasOwnProperty("rowsAffected")) {
                result.affected = raw.rowsAffected;
            }
            if (useStructuredResult) {
                return result;
            }
            else {
                return result.raw;
            }
        }
        catch (err) {
            this.driver.connection.logger.logQueryError(err, query, parameters, this);
            this.broadcaster.broadcastAfterQueryEvent(broadcasterResult, query, parameters, false, undefined, undefined, err);
            throw new QueryFailedError_1.QueryFailedError(query, parameters, err);
        }
        finally {
            await broadcasterResult.wait();
        }
    }
    /**
     * Returns raw data stream.
     */
    async stream(query, parameters, onEnd, onError) {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError_1.QueryRunnerAlreadyReleasedError();
        try {
            const databaseConnection = await this.connect();
            this.driver.connection.logger.logQuery(query, parameters, this);
            const executionOptions = {
                autoCommit: !this.isTransactionActive,
                outFormat: this.driver.dmdb.OUT_FORMAT_OBJECT,
            };
            const stream = databaseConnection.queryStream(query, parameters, executionOptions);
            if (onEnd) {
                stream.on("end", onEnd);
            }
            if (onError) {
                stream.on("error", onError);
            }
            return stream;
        }
        catch (err) {
            this.driver.connection.logger.logQueryError(err, query, parameters, this);
            throw new QueryFailedError_1.QueryFailedError(query, parameters, err);
        }
    }
    /**
     * Returns all available database names including system databases.
     */
    async getDatabases() {
        throw new TypeORMError_1.TypeORMError(`Dameng driver does not support databases`);
    }
    /**
     * Returns all available schema names including system schemas.
     * If database parameter specified, returns schemas of that database.
     */
    async getSchemas(database) {
        const results = await this.query(`SELECT NAME AS "schema_name" FROM SYSOBJECTS WHERE TYPE$='SCH'`);
        return results.map((result) => result["schema_name"]);
    }
    /**
     * Checks if database with the given name exist.
     */
    async hasDatabase(database) {
        throw new TypeORMError_1.TypeORMError(`Dameng driver does not support databases`);
    }
    /**
     * Loads currently using database
     */
    async getCurrentDatabase() {
        throw new TypeORMError_1.TypeORMError(`Dameng driver does not support databases`);
    }
    /**
     * Checks if schema with the given name exist.
     */
    async hasSchema(schema) {
        const results = await this.query(`SELECT 1 FROM SYSOBJECTS WHERE TYPE$='SCH' AND NAME=?`, [schema]);
        return results.length > 0;
    }
    /**
     * Loads currently using database schema
     */
    async getCurrentSchema() {
        const results = await this.query(`SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS "schema_name"`);
        return results[0]["schema_name"];
    }
    /**
     * Checks if table with the given name exist in the database.
     */
    async hasTable(tableOrName) {
        const { schema, tableName } = this.driver.parseTableName(tableOrName);
        const sql = `SELECT /*+ MAX_OPT_N_TABLES(5) */ COUNT(TABS.NAME) AS "cnt" FROM
                    (SELECT ID, PID FROM SYS.SYSOBJECTS WHERE TYPE$ = 'SCH' AND NAME = ?) SCHEMAS,
                    (SELECT ID, SCHID, NAME FROM SYS.SYSOBJECTS WHERE
                    NAME = ? AND TYPE$ = 'SCHOBJ' AND SUBTYPE$ IN ('UTAB', 'STAB', 'VIEW', 'SYNOM')
                    AND ((SUBTYPE$ ='UTAB' AND CAST((INFO3 & 0x00FF & 0x003F) AS INT) not in (9, 27, 29, 25, 12, 7, 21, 23, 18, 5))
                    OR SUBTYPE$ in ('STAB', 'VIEW', 'SYNOM'))) TABS
                    WHERE TABS.SCHID = SCHEMAS.ID AND SF_CHECK_PRIV_OPT(UID(), CURRENT_USERTYPE(), TABS.ID, SCHEMAS.PID, -1, TABS.ID) = 1`;
        const results = await this.query(sql, [
            schema,
            tableName,
        ]);
        return results[0]["cnt"] > 0;
    }
    /**
     * Checks if column with the given name exist in the given table.
     */
    async hasColumn(tableOrName, column) {
        const { schema, tableName } = this.driver.parseTableName(tableOrName);
        const columnName = InstanceChecker_1.InstanceChecker.isTableColumn(column)
            ? column.name
            : column;
        const sql = `SELECT /*+ MAX_OPT_N_TABLES(5) */ COUNT(DISTINCT COLS.NAME) AS "cnt" FROM
                    (SELECT ID FROM SYS.SYSOBJECTS WHERE TYPE$ = 'SCH' AND NAME = ?) SCHS,
                    (SELECT ID, SCHID FROM SYS.SYSOBJECTS WHERE TYPE$ = 'SCHOBJ' AND SUBTYPE$ IN ('UTAB', 'STAB', 'VIEW') AND NAME = ?) TABS,
                    (SELECT NAME, ID FROM SYS.SYSCOLUMNS WHERE NAME = ?) COLS
                    WHERE TABS.ID = COLS.ID AND SCHS.ID = TABS.SCHID`;
        const results = await this.query(sql, [
            schema,
            tableName,
            columnName,
        ]);
        return results[0]["cnt"] > 0;
    }
    /**
     * Creates a new database.
     */
    async createDatabase(database, ifNotExist) {
        throw new TypeORMError_1.TypeORMError(`Dameng driver does not support databases`);
    }
    /**
     * Drops database.
     */
    async dropDatabase(database, ifExist) {
        throw new TypeORMError_1.TypeORMError(`Dameng driver does not support databases`);
    }
    /**
     * Creates a new table schema.
     */
    async createSchema(schemaPath, ifNotExist) {
        let exist = false;
        if (ifNotExist) {
            exist = await this.hasSchema(schemaPath);
        }
        if (!ifNotExist || (ifNotExist && !exist)) {
            const up = `CREATE SCHEMA "${schemaPath}"`;
            const down = `DROP SCHEMA "${schemaPath}" CASCASE`;
            await this.executeQueries(new Query_1.Query(up), new Query_1.Query(down));
        }
    }
    /**
     * Drops table schema.
     */
    async dropSchema(schemaPath, ifExist) {
        const up = ifExist
            ? `DROP SCHEMA IF EXISTS "${schemaPath}"`
            : `DROP SCHEMA "${schemaPath}"`;
        const down = `CREATE SCHEMA "${schemaPath}"`;
        await this.executeQueries(new Query_1.Query(up), new Query_1.Query(down));
    }
    /**
     * Creates a new table.
     */
    async createTable(table, ifNotExist = false, createForeignKeys = true, createIndices = true) {
        if (ifNotExist) {
            const isTableExist = await this.hasTable(table);
            if (isTableExist)
                return Promise.resolve();
        }
        const upQueries = [];
        const downQueries = [];
        upQueries.push(this.createTableSql(table, createForeignKeys));
        downQueries.push(this.dropTableSql(table));
        // if createForeignKeys is true, we must drop created foreign keys in down query.
        // createTable does not need separate method to create foreign keys, because it create fk's in the same query with table creation.
        if (createForeignKeys)
            table.foreignKeys.forEach((foreignKey) => downQueries.push(this.dropForeignKeySql(table, foreignKey)));
        if (createIndices)
            table.indices.forEach((index) => {
                // new index may be passed without name. In this case we generate index name manually.
                if (!index.name)
                    index.name = this.connection.namingStrategy.indexName(table, index.columnNames, index.where);
                upQueries.push(this.createIndexSql(table, index));
                downQueries.push(this.dropIndexSql(table, index));
            });
        // if table has column with generated type, we must add the expression to the metadata table
        const generatedColumns = table.columns.filter((column) => column.generatedType && column.asExpression);
        for (const column of generatedColumns) {
            const insertQuery = this.insertTypeormMetadataSql({
                schema: table.schema,
                table: table.name,
                type: MetadataTableType_1.MetadataTableType.GENERATED_COLUMN,
                name: column.name,
                value: column.asExpression,
            });
            const deleteQuery = this.deleteTypeormMetadataSql({
                schema: table.schema,
                table: table.name,
                type: MetadataTableType_1.MetadataTableType.GENERATED_COLUMN,
                name: column.name,
            });
            upQueries.push(insertQuery);
            downQueries.push(deleteQuery);
        }
        return this.executeQueries(upQueries, downQueries);
    }
    /**
     * Drop the table.
     */
    async dropTable(tableOrName, ifExist, dropForeignKeys = true, dropIndices = true) {
        // It needs because if table does not exist and dropForeignKeys or dropIndices is true, we don't need
        // to perform drop queries for foreign keys and indices.
        if (ifExist) {
            const isTableExist = await this.hasTable(tableOrName);
            if (!isTableExist)
                return Promise.resolve();
        }
        // if dropTable called with dropForeignKeys = true, we must create foreign keys in down query.
        const createForeignKeys = dropForeignKeys;
        const table = InstanceChecker_1.InstanceChecker.isTable(tableOrName)
            ? tableOrName
            : await this.getCachedTable(tableOrName);
        const upQueries = [];
        const downQueries = [];
        if (dropIndices) {
            table.indices.forEach((index) => {
                upQueries.push(this.dropIndexSql(table, index));
                downQueries.push(this.createIndexSql(table, index));
            });
        }
        // if dropForeignKeys is true, we just drop the table, otherwise we also drop table foreign keys.
        // createTable does not need separate method to create foreign keys, because it create fk's in the same query with table creation.
        if (dropForeignKeys)
            table.foreignKeys.forEach((foreignKey) => upQueries.push(this.dropForeignKeySql(table, foreignKey)));
        upQueries.push(this.dropTableSql(table));
        downQueries.push(this.createTableSql(table, createForeignKeys));
        // if table had columns with generated type, we must remove the expression from the metadata table
        const generatedColumns = table.columns.filter((column) => column.generatedType && column.asExpression);
        for (const column of generatedColumns) {
            const deleteQuery = this.deleteTypeormMetadataSql({
                schema: table.schema,
                table: table.name,
                type: MetadataTableType_1.MetadataTableType.GENERATED_COLUMN,
                name: column.name,
            });
            const insertQuery = this.insertTypeormMetadataSql({
                schema: table.schema,
                table: table.name,
                type: MetadataTableType_1.MetadataTableType.GENERATED_COLUMN,
                name: column.name,
                value: column.asExpression,
            });
            upQueries.push(deleteQuery);
            downQueries.push(insertQuery);
        }
        await this.executeQueries(upQueries, downQueries);
    }
    /**
     * Creates a new view.
     */
    async createView(view, syncWithMetadata = false) {
        const upQueries = [];
        const downQueries = [];
        upQueries.push(this.createViewSql(view));
        if (syncWithMetadata)
            upQueries.push(this.insertViewDefinitionSql(view));
        downQueries.push(this.dropViewSql(view));
        if (syncWithMetadata)
            downQueries.push(this.deleteViewDefinitionSql(view));
        await this.executeQueries(upQueries, downQueries);
    }
    /**
     * Drops the view.
     */
    async dropView(target) {
        const viewName = InstanceChecker_1.InstanceChecker.isView(target) ? target.name : target;
        const view = await this.getCachedView(viewName);
        const upQueries = [];
        const downQueries = [];
        upQueries.push(this.deleteViewDefinitionSql(view));
        upQueries.push(this.dropViewSql(view));
        downQueries.push(this.insertViewDefinitionSql(view));
        downQueries.push(this.createViewSql(view));
        await this.executeQueries(upQueries, downQueries);
    }
    /**
     * Renames a table.
     */
    async renameTable(oldTableOrName, newTableName) {
        const upQueries = [];
        const downQueries = [];
        const oldTable = InstanceChecker_1.InstanceChecker.isTable(oldTableOrName)
            ? oldTableOrName
            : await this.getCachedTable(oldTableOrName);
        const newTable = oldTable.clone();
        const { schema: schemaName, tableName: oldTableName } = this.driver.parseTableName(oldTable);
        newTable.name = schemaName
            ? `${schemaName}.${newTableName}`
            : newTableName;
        // rename table
        upQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(oldTable)} RENAME TO "${newTableName}"`));
        downQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(newTable)} RENAME TO "${oldTableName}"`));
        // rename primary key constraint
        if (newTable.primaryColumns.length > 0 &&
            !newTable.primaryColumns[0].primaryKeyConstraintName) {
            const columnNames = newTable.primaryColumns.map((column) => column.name);
            const oldPkName = this.connection.namingStrategy.primaryKeyName(oldTable, columnNames);
            const newPkName = this.connection.namingStrategy.primaryKeyName(newTable, columnNames);
            // build queries
            upQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(newTable)} RENAME CONSTRAINT "${oldPkName}" TO "${newPkName}"`));
            downQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(newTable)} RENAME CONSTRAINT "${newPkName}" TO "${oldPkName}"`));
        }
        // rename unique constraints
        newTable.uniques.forEach((unique) => {
            const oldUniqueName = this.connection.namingStrategy.uniqueConstraintName(oldTable, unique.columnNames);
            // Skip renaming if Unique has user defined constraint name
            if (unique.name !== oldUniqueName)
                return;
            // build new constraint name
            const newUniqueName = this.connection.namingStrategy.uniqueConstraintName(newTable, unique.columnNames);
            // build queries
            upQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(newTable)} RENAME CONSTRAINT "${unique.name}" TO "${newUniqueName}"`));
            downQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(newTable)} RENAME CONSTRAINT "${newUniqueName}" TO "${unique.name}"`));
            // replace constraint name
            unique.name = newUniqueName;
        });
        // rename index constraints
        newTable.indices.forEach((index) => {
            const oldIndexName = this.connection.namingStrategy.indexName(oldTable, index.columnNames, index.where);
            // Skip renaming if Index has user defined constraint name
            if (index.name !== oldIndexName)
                return;
            // build new constraint name
            const newIndexName = this.connection.namingStrategy.indexName(newTable, index.columnNames, index.where);
            // build queries
            upQueries.push(new Query_1.Query(`ALTER INDEX "${index.name}" RENAME TO "${newIndexName}"`));
            downQueries.push(new Query_1.Query(`ALTER INDEX "${newIndexName}" RENAME TO "${index.name}"`));
            // replace constraint name
            index.name = newIndexName;
        });
        // rename foreign key constraint
        newTable.foreignKeys.forEach((foreignKey) => {
            const oldForeignKeyName = this.connection.namingStrategy.foreignKeyName(oldTable, foreignKey.columnNames, this.getTablePath(foreignKey), foreignKey.referencedColumnNames);
            // Skip renaming if foreign key has user defined constraint name
            if (foreignKey.name !== oldForeignKeyName)
                return;
            // build new constraint name
            const newForeignKeyName = this.connection.namingStrategy.foreignKeyName(newTable, foreignKey.columnNames, this.getTablePath(foreignKey), foreignKey.referencedColumnNames);
            // build queries
            upQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(newTable)} RENAME CONSTRAINT "${foreignKey.name}" TO "${newForeignKeyName}"`));
            downQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(newTable)} RENAME CONSTRAINT "${newForeignKeyName}" TO "${foreignKey.name}"`));
            // replace constraint name
            foreignKey.name = newForeignKeyName;
        });
        await this.executeQueries(upQueries, downQueries);
        // rename old table and replace it in cached tabled;
        oldTable.name = newTable.name;
        this.replaceCachedTable(oldTable, newTable);
    }
    /**
     * Change table comment.
     */
    async changeTableComment(tableOrName, newComment) {
        const upQueries = [];
        const downQueries = [];
        const table = InstanceChecker_1.InstanceChecker.isTable(tableOrName)
            ? tableOrName
            : await this.getCachedTable(tableOrName);
        newComment = this.escapeComment(newComment);
        const comment = this.escapeComment(table.comment);
        if (newComment === comment) {
            return;
        }
        const newTable = table.clone();
        upQueries.push(new Query_1.Query(`COMMENT ON TABLE ${this.escapePath(newTable)} IS ${newComment}`));
        downQueries.push(new Query_1.Query(`COMMENT ON TABLE ${this.escapePath(table)} IS ${comment}`));
        await this.executeQueries(upQueries, downQueries);
        // change table comment and replace it in cached tabled;
        table.comment = newTable.comment;
        this.replaceCachedTable(table, newTable);
    }
    /**
     * Creates a new column from the column in the table.
     */
    async addColumn(tableOrName, column) {
        const table = InstanceChecker_1.InstanceChecker.isTable(tableOrName)
            ? tableOrName
            : await this.getCachedTable(tableOrName);
        const clonedTable = table.clone();
        const upQueries = [];
        const downQueries = [];
        upQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} ADD ${this.buildCreateColumnSql(table, column, true, false)}`));
        downQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} DROP COLUMN "${column.name}" CASCADE`));
        // create or update primary key constraint
        if (column.isPrimary) {
            const primaryColumns = clonedTable.primaryColumns;
            // if table already have primary key, me must drop it and recreate again
            if (primaryColumns.length > 0) {
                const pkName = primaryColumns[0].primaryKeyConstraintName
                    ? primaryColumns[0].primaryKeyConstraintName
                    : this.connection.namingStrategy.primaryKeyName(clonedTable, primaryColumns.map((column) => column.name));
                const columnNames = primaryColumns
                    .map((column) => `"${column.name}"`)
                    .join(", ");
                upQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${pkName}"`));
                downQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${pkName}" PRIMARY KEY (${columnNames})`));
            }
            primaryColumns.push(column);
            const pkName = primaryColumns[0].primaryKeyConstraintName
                ? primaryColumns[0].primaryKeyConstraintName
                : this.connection.namingStrategy.primaryKeyName(clonedTable, primaryColumns.map((column) => column.name));
            const columnNames = primaryColumns
                .map((column) => `"${column.name}"`)
                .join(", ");
            upQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${pkName}" PRIMARY KEY (${columnNames})`));
            downQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${pkName}"`));
        }
        // create column index
        const columnIndex = clonedTable.indices.find((index) => index.columnNames.length === 1 &&
            index.columnNames[0] === column.name);
        if (columnIndex) {
            clonedTable.indices.splice(clonedTable.indices.indexOf(columnIndex), 1);
            upQueries.push(this.createIndexSql(table, columnIndex));
            downQueries.push(this.dropIndexSql(table, columnIndex));
        }
        // create unique constraint
        if (column.isUnique) {
            const uniqueConstraint = new TableUnique_1.TableUnique({
                name: this.connection.namingStrategy.uniqueConstraintName(table, [column.name]),
                columnNames: [column.name],
            });
            clonedTable.uniques.push(uniqueConstraint);
            upQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${uniqueConstraint.name}" UNIQUE ("${column.name}")`));
            downQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${uniqueConstraint.name}"`));
        }
        if (column.generatedType && column.asExpression) {
            const insertQuery = this.insertTypeormMetadataSql({
                schema: table.schema,
                table: table.name,
                type: MetadataTableType_1.MetadataTableType.GENERATED_COLUMN,
                name: column.name,
                value: column.asExpression,
            });
            const deleteQuery = this.deleteTypeormMetadataSql({
                schema: table.schema,
                table: table.name,
                type: MetadataTableType_1.MetadataTableType.GENERATED_COLUMN,
                name: column.name,
            });
            upQueries.push(insertQuery);
            downQueries.push(deleteQuery);
        }
        // create column comment
        if (column.comment) {
            upQueries.push(new Query_1.Query(`COMMENT ON COLUMN ${this.escapePath(table)}."${column.name}" IS ${this.escapeComment(column.comment)}`));
            downQueries.push(new Query_1.Query(`COMMENT ON COLUMN ${this.escapePath(table)}."${column.name}" IS ${this.escapeComment(column.comment)}`));
        }
        await this.executeQueries(upQueries, downQueries);
        clonedTable.addColumn(column);
        this.replaceCachedTable(table, clonedTable);
    }
    /**
     * Creates a new columns from the column in the table.
     */
    async addColumns(tableOrName, columns) {
        for (const column of columns) {
            await this.addColumn(tableOrName, column);
        }
    }
    /**
     * Renames column in the given table.
     */
    async renameColumn(tableOrName, oldTableColumnOrName, newTableColumnOrName) {
        const table = InstanceChecker_1.InstanceChecker.isTable(tableOrName)
            ? tableOrName
            : await this.getCachedTable(tableOrName);
        const oldColumn = InstanceChecker_1.InstanceChecker.isTableColumn(oldTableColumnOrName)
            ? oldTableColumnOrName
            : table.columns.find((c) => c.name === oldTableColumnOrName);
        if (!oldColumn)
            throw new TypeORMError_1.TypeORMError(`Column "${oldTableColumnOrName}" was not found in the "${table.name}" table.`);
        let newColumn = undefined;
        if (InstanceChecker_1.InstanceChecker.isTableColumn(newTableColumnOrName)) {
            newColumn = newTableColumnOrName;
        }
        else {
            newColumn = oldColumn.clone();
            newColumn.name = newTableColumnOrName;
        }
        await this.changeColumn(table, oldColumn, newColumn);
    }
    /**
     * Changes a column in the table.
     */
    async changeColumn(tableOrName, oldColumnOrName, newColumn) {
        const table = InstanceChecker_1.InstanceChecker.isTable(tableOrName)
            ? tableOrName
            : await this.getCachedTable(tableOrName);
        let clonedTable = table.clone();
        const upQueries = [];
        const downQueries = [];
        const oldColumn = InstanceChecker_1.InstanceChecker.isTableColumn(oldColumnOrName)
            ? oldColumnOrName
            : table.columns.find((column) => column.name === oldColumnOrName);
        if (!oldColumn)
            throw new TypeORMError_1.TypeORMError(`Column "${oldColumnOrName}" was not found in the "${table.name}" table.`);
        if ((newColumn.isGenerated !== oldColumn.isGenerated &&
            newColumn.generationStrategy !== "uuid") ||
            oldColumn.type !== newColumn.type ||
            oldColumn.length !== newColumn.length ||
            oldColumn.generatedType !== newColumn.generatedType ||
            oldColumn.asExpression !== newColumn.asExpression) {
            await this.dropColumn(table, oldColumn);
            await this.addColumn(table, newColumn);
            // update cloned table
            clonedTable = table.clone();
        }
        else {
            if (newColumn.name !== oldColumn.name) {
                // rename column
                upQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} RENAME COLUMN "${oldColumn.name}" TO "${newColumn.name}"`));
                downQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} RENAME COLUMN "${newColumn.name}" TO "${oldColumn.name}"`));
                // rename column primary key constraint
                if (oldColumn.isPrimary === true &&
                    !oldColumn.primaryKeyConstraintName) {
                    const primaryColumns = clonedTable.primaryColumns;
                    // build old primary constraint name
                    const columnNames = primaryColumns.map((column) => column.name);
                    const oldPkName = this.connection.namingStrategy.primaryKeyName(clonedTable, columnNames);
                    // replace old column name with new column name
                    columnNames.splice(columnNames.indexOf(oldColumn.name), 1);
                    columnNames.push(newColumn.name);
                    // build new primary constraint name
                    const newPkName = this.connection.namingStrategy.primaryKeyName(clonedTable, columnNames);
                    upQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} RENAME CONSTRAINT "${oldPkName}" TO "${newPkName}"`));
                    downQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} RENAME CONSTRAINT "${newPkName}" TO "${oldPkName}"`));
                }
                // rename unique constraints
                clonedTable.findColumnUniques(oldColumn).forEach((unique) => {
                    const oldUniqueName = this.connection.namingStrategy.uniqueConstraintName(clonedTable, unique.columnNames);
                    // Skip renaming if Unique has user defined constraint name
                    if (unique.name !== oldUniqueName)
                        return;
                    // build new constraint name
                    unique.columnNames.splice(unique.columnNames.indexOf(oldColumn.name), 1);
                    unique.columnNames.push(newColumn.name);
                    const newUniqueName = this.connection.namingStrategy.uniqueConstraintName(clonedTable, unique.columnNames);
                    // build queries
                    upQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} RENAME CONSTRAINT "${unique.name}" TO "${newUniqueName}"`));
                    downQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} RENAME CONSTRAINT "${newUniqueName}" TO "${unique.name}"`));
                    // replace constraint name
                    unique.name = newUniqueName;
                });
                // rename index constraints
                clonedTable.findColumnIndices(oldColumn).forEach((index) => {
                    const oldIndexName = this.connection.namingStrategy.indexName(clonedTable, index.columnNames, index.where);
                    // Skip renaming if Index has user defined constraint name
                    if (index.name !== oldIndexName)
                        return;
                    // build new constraint name
                    index.columnNames.splice(index.columnNames.indexOf(oldColumn.name), 1);
                    index.columnNames.push(newColumn.name);
                    const newIndexName = this.connection.namingStrategy.indexName(clonedTable, index.columnNames, index.where);
                    // build queries
                    upQueries.push(new Query_1.Query(`ALTER INDEX "${index.name}" RENAME TO "${newIndexName}"`));
                    downQueries.push(new Query_1.Query(`ALTER INDEX "${newIndexName}" RENAME TO "${index.name}"`));
                    // replace constraint name
                    index.name = newIndexName;
                });
                // rename foreign key constraints
                // rename foreign key constraints
                clonedTable
                    .findColumnForeignKeys(oldColumn)
                    .forEach((foreignKey) => {
                    const foreignKeyName = this.connection.namingStrategy.foreignKeyName(clonedTable, foreignKey.columnNames, this.getTablePath(foreignKey), foreignKey.referencedColumnNames);
                    // Skip renaming if foreign key has user defined constraint name
                    if (foreignKey.name !== foreignKeyName)
                        return;
                    // build new constraint name
                    foreignKey.columnNames.splice(foreignKey.columnNames.indexOf(oldColumn.name), 1);
                    foreignKey.columnNames.push(newColumn.name);
                    const newForeignKeyName = this.connection.namingStrategy.foreignKeyName(clonedTable, foreignKey.columnNames, this.getTablePath(foreignKey), foreignKey.referencedColumnNames);
                    // build queries
                    upQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} RENAME CONSTRAINT "${foreignKey.name}" TO "${newForeignKeyName}"`));
                    downQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} RENAME CONSTRAINT "${newForeignKeyName}" TO "${foreignKey.name}"`));
                    // replace constraint name
                    foreignKey.name = newForeignKeyName;
                });
                // rename old column in the Table object
                const oldTableColumn = clonedTable.columns.find((column) => column.name === oldColumn.name);
                clonedTable.columns[clonedTable.columns.indexOf(oldTableColumn)].name = newColumn.name;
                oldColumn.name = newColumn.name;
            }
            if (this.isColumnChanged(oldColumn, newColumn, true, false, false)) {
                let defaultUp = "";
                let defaultDown = "";
                let nullableUp = "";
                let nullableDown = "";
                // changing column default
                if (newColumn.default !== null &&
                    newColumn.default !== undefined) {
                    defaultUp = `DEFAULT ${newColumn.default}`;
                    if (oldColumn.default !== null &&
                        oldColumn.default !== undefined) {
                        defaultDown = `DEFAULT ${oldColumn.default}`;
                    }
                    else {
                        defaultDown = "DEFAULT NULL";
                    }
                }
                else if (oldColumn.default !== null &&
                    oldColumn.default !== undefined) {
                    defaultUp = "DEFAULT NULL";
                    defaultDown = `DEFAULT ${oldColumn.default}`;
                }
                // changing column isNullable property
                if (newColumn.isNullable !== oldColumn.isNullable) {
                    if (newColumn.isNullable === true) {
                        nullableUp = "NULL";
                        nullableDown = "NOT NULL";
                    }
                    else {
                        nullableUp = "NOT NULL";
                        nullableDown = "NULL";
                    }
                }
                upQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} MODIFY "${oldColumn.name}" ${this.connection.driver.createFullType(newColumn)} ${defaultUp} ${nullableUp}`));
                downQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} MODIFY "${oldColumn.name}" ${this.connection.driver.createFullType(oldColumn)} ${defaultDown} ${nullableDown}`));
            }
            // changing column comment property
            if (newColumn.comment !== oldColumn.comment) {
                upQueries.push(new Query_1.Query(`COMMENT ON COLUMN ${this.escapePath(table)}."${oldColumn.name}" IS ${this.escapeComment(newColumn.comment)}`));
                downQueries.push(new Query_1.Query(`COMMENT ON COLUMN ${this.escapePath(table)}."${newColumn.name}" IS ${this.escapeComment(oldColumn.comment)}`));
            }
            if (this.isEnumChanged(oldColumn, newColumn)) {
                const oldExpression = this.getEnumExpression(oldColumn);
                const oldCheck = oldExpression ? new TableCheck_1.TableCheck({
                    name: this.connection.namingStrategy.checkConstraintName(table, oldExpression, true),
                    expression: oldExpression,
                }) : undefined;
                const newExpression = this.getEnumExpression(newColumn);
                const newCheck = newExpression ? new TableCheck_1.TableCheck({
                    name: this.connection.namingStrategy.checkConstraintName(table, newExpression, true),
                    expression: newExpression,
                }) : undefined;
                if (oldCheck) {
                    upQueries.push(this.dropCheckConstraintSql(table, oldCheck));
                }
                if (newCheck) {
                    upQueries.push(this.createCheckConstraintSql(table, newCheck));
                }
                if (newCheck) {
                    downQueries.push(this.dropCheckConstraintSql(table, newCheck));
                }
                if (oldCheck) {
                    downQueries.push(this.createCheckConstraintSql(table, oldCheck));
                }
            }
            if (newColumn.isPrimary !== oldColumn.isPrimary) {
                const primaryColumns = clonedTable.primaryColumns;
                // if primary column state changed, we must always drop existed constraint.
                if (primaryColumns.length > 0) {
                    const pkName = primaryColumns[0].primaryKeyConstraintName
                        ? primaryColumns[0].primaryKeyConstraintName
                        : this.connection.namingStrategy.primaryKeyName(clonedTable, primaryColumns.map((column) => column.name));
                    const columnNames = primaryColumns
                        .map((column) => `"${column.name}"`)
                        .join(", ");
                    upQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${pkName}"`));
                    downQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${pkName}" PRIMARY KEY (${columnNames})`));
                }
                if (newColumn.isPrimary === true) {
                    primaryColumns.push(newColumn);
                    // update column in table
                    const column = clonedTable.columns.find((column) => column.name === newColumn.name);
                    column.isPrimary = true;
                    const pkName = primaryColumns[0].primaryKeyConstraintName
                        ? primaryColumns[0].primaryKeyConstraintName
                        : this.connection.namingStrategy.primaryKeyName(clonedTable, primaryColumns.map((column) => column.name));
                    const columnNames = primaryColumns
                        .map((column) => `"${column.name}"`)
                        .join(", ");
                    upQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${pkName}" PRIMARY KEY (${columnNames})`));
                    downQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${pkName}"`));
                }
                else {
                    const primaryColumn = primaryColumns.find((c) => c.name === newColumn.name);
                    primaryColumns.splice(primaryColumns.indexOf(primaryColumn), 1);
                    // update column in table
                    const column = clonedTable.columns.find((column) => column.name === newColumn.name);
                    column.isPrimary = false;
                    // if we have another primary keys, we must recreate constraint.
                    if (primaryColumns.length > 0) {
                        const pkName = primaryColumns[0]
                            .primaryKeyConstraintName
                            ? primaryColumns[0].primaryKeyConstraintName
                            : this.connection.namingStrategy.primaryKeyName(clonedTable, primaryColumns.map((column) => column.name));
                        const columnNames = primaryColumns
                            .map((column) => `"${column.name}"`)
                            .join(", ");
                        upQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${pkName}" PRIMARY KEY (${columnNames})`));
                        downQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${pkName}"`));
                    }
                }
            }
            if (newColumn.isUnique !== oldColumn.isUnique) {
                if (newColumn.isUnique === true) {
                    const uniqueConstraint = new TableUnique_1.TableUnique({
                        name: this.connection.namingStrategy.uniqueConstraintName(table, [newColumn.name]),
                        columnNames: [newColumn.name],
                    });
                    clonedTable.uniques.push(uniqueConstraint);
                    upQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${uniqueConstraint.name}" UNIQUE ("${newColumn.name}")`));
                    downQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${uniqueConstraint.name}"`));
                }
                else {
                    const uniqueConstraint = clonedTable.uniques.find((unique) => {
                        return (unique.columnNames.length === 1 &&
                            !!unique.columnNames.find((columnName) => columnName === newColumn.name));
                    });
                    clonedTable.uniques.splice(clonedTable.uniques.indexOf(uniqueConstraint), 1);
                    upQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${uniqueConstraint.name}"`));
                    downQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${uniqueConstraint.name}" UNIQUE ("${newColumn.name}")`));
                }
            }
        }
        await this.executeQueries(upQueries, downQueries);
        this.replaceCachedTable(table, clonedTable);
    }
    /**
     * Changes a column in the table.
     */
    async changeColumns(tableOrName, changedColumns) {
        for (const { oldColumn, newColumn } of changedColumns) {
            await this.changeColumn(tableOrName, oldColumn, newColumn);
        }
    }
    /**
     * Drops column in the table.
     */
    async dropColumn(tableOrName, columnOrName) {
        const table = InstanceChecker_1.InstanceChecker.isTable(tableOrName)
            ? tableOrName
            : await this.getCachedTable(tableOrName);
        const column = InstanceChecker_1.InstanceChecker.isTableColumn(columnOrName)
            ? columnOrName
            : table.findColumnByName(columnOrName);
        if (!column)
            throw new TypeORMError_1.TypeORMError(`Column "${columnOrName}" was not found in table "${table.name}"`);
        const clonedTable = table.clone();
        const upQueries = [];
        const downQueries = [];
        // drop primary key constraint
        if (column.isPrimary) {
            const pkName = column.primaryKeyConstraintName
                ? column.primaryKeyConstraintName
                : this.connection.namingStrategy.primaryKeyName(clonedTable, clonedTable.primaryColumns.map((column) => column.name));
            const columnNames = clonedTable.primaryColumns
                .map((primaryColumn) => `"${primaryColumn.name}"`)
                .join(", ");
            upQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(clonedTable)} DROP CONSTRAINT "${pkName}"`));
            downQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(clonedTable)} ADD CONSTRAINT "${pkName}" PRIMARY KEY (${columnNames})`));
            // update column in table
            const tableColumn = clonedTable.findColumnByName(column.name);
            tableColumn.isPrimary = false;
            // if primary key have multiple columns, we must recreate it without dropped column
            if (clonedTable.primaryColumns.length > 0) {
                const pkName = clonedTable.primaryColumns[0]
                    .primaryKeyConstraintName
                    ? clonedTable.primaryColumns[0].primaryKeyConstraintName
                    : this.connection.namingStrategy.primaryKeyName(clonedTable, clonedTable.primaryColumns.map((column) => column.name));
                const columnNames = clonedTable.primaryColumns
                    .map((primaryColumn) => `"${primaryColumn.name}"`)
                    .join(", ");
                upQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(clonedTable)} ADD CONSTRAINT "${pkName}" PRIMARY KEY (${columnNames})`));
                downQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(clonedTable)} DROP CONSTRAINT "${pkName}"`));
            }
        }
        // drop column index
        const columnIndex = clonedTable.indices.find((index) => index.columnNames.length === 1 &&
            index.columnNames[0] === column.name);
        if (columnIndex) {
            upQueries.push(this.dropIndexSql(table, columnIndex));
            downQueries.push(this.createIndexSql(table, columnIndex));
        }
        // drop column check
        const columnCheck = clonedTable.checks.find((check) => !!check.columnNames &&
            check.columnNames.length === 1 &&
            check.columnNames[0] === column.name);
        if (columnCheck) {
            clonedTable.checks.splice(clonedTable.checks.indexOf(columnCheck), 1);
            upQueries.push(this.dropCheckConstraintSql(table, columnCheck));
            downQueries.push(this.createCheckConstraintSql(table, columnCheck));
        }
        // drop column unique
        const columnUnique = clonedTable.uniques.find((unique) => unique.columnNames.length === 1 &&
            unique.columnNames[0] === column.name);
        if (columnUnique) {
            clonedTable.uniques.splice(clonedTable.uniques.indexOf(columnUnique), 1);
            upQueries.push(this.dropUniqueConstraintSql(table, columnUnique));
            downQueries.push(this.createUniqueConstraintSql(table, columnUnique));
        }
        upQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} DROP COLUMN "${column.name}" CASCADE`));
        downQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} ADD ${this.buildCreateColumnSql(table, column, true, false)}`));
        if (column.generatedType && column.asExpression) {
            const deleteQuery = this.deleteTypeormMetadataSql({
                table: table.name,
                type: MetadataTableType_1.MetadataTableType.GENERATED_COLUMN,
                name: column.name,
            });
            const insertQuery = this.insertTypeormMetadataSql({
                table: table.name,
                type: MetadataTableType_1.MetadataTableType.GENERATED_COLUMN,
                name: column.name,
                value: column.asExpression,
            });
            upQueries.push(deleteQuery);
            downQueries.push(insertQuery);
        }
        await this.executeQueries(upQueries, downQueries);
        clonedTable.removeColumn(column);
        this.replaceCachedTable(table, clonedTable);
    }
    /**
     * Drops the columns in the table.
     */
    async dropColumns(tableOrName, columns) {
        for (const column of columns) {
            await this.dropColumn(tableOrName, column);
        }
    }
    /**
     * Creates a new primary key.
     */
    async createPrimaryKey(tableOrName, columnNames) {
        const table = InstanceChecker_1.InstanceChecker.isTable(tableOrName)
            ? tableOrName
            : await this.getCachedTable(tableOrName);
        const clonedTable = table.clone();
        const up = this.createPrimaryKeySql(table, columnNames);
        // mark columns as primary, because dropPrimaryKeySql build constraint name from table primary column names.
        clonedTable.columns.forEach((column) => {
            if (columnNames.find((columnName) => columnName === column.name))
                column.isPrimary = true;
        });
        const down = this.dropPrimaryKeySql(clonedTable);
        await this.executeQueries(up, down);
        this.replaceCachedTable(table, clonedTable);
    }
    /**
     * Updates composite primary keys.
     */
    async updatePrimaryKeys(tableOrName, columns) {
        const table = InstanceChecker_1.InstanceChecker.isTable(tableOrName)
            ? tableOrName
            : await this.getCachedTable(tableOrName);
        const columnNames = columns.map((column) => column.name);
        const clonedTable = table.clone();
        const upQueries = [];
        const downQueries = [];
        // if table already have primary columns, we must drop them.
        const primaryColumns = clonedTable.primaryColumns;
        if (primaryColumns.length > 0) {
            const pkName = primaryColumns[0].primaryKeyConstraintName
                ? primaryColumns[0].primaryKeyConstraintName
                : this.connection.namingStrategy.primaryKeyName(clonedTable, primaryColumns.map((column) => column.name));
            const columnNamesString = primaryColumns
                .map((column) => `"${column.name}"`)
                .join(", ");
            upQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${pkName}"`));
            downQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${pkName}" PRIMARY KEY (${columnNamesString})`));
        }
        // update columns in table.
        clonedTable.columns
            .filter((column) => columnNames.indexOf(column.name) !== -1)
            .forEach((column) => (column.isPrimary = true));
        const pkName = primaryColumns[0]?.primaryKeyConstraintName
            ? primaryColumns[0].primaryKeyConstraintName
            : this.connection.namingStrategy.primaryKeyName(clonedTable, columnNames);
        const columnNamesString = columnNames
            .map((columnName) => `"${columnName}"`)
            .join(", ");
        upQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${pkName}" PRIMARY KEY (${columnNamesString})`));
        downQueries.push(new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${pkName}"`));
        await this.executeQueries(upQueries, downQueries);
        this.replaceCachedTable(table, clonedTable);
    }
    /**
     * Drops a primary key.
     */
    async dropPrimaryKey(tableOrName, constraintName) {
        const table = InstanceChecker_1.InstanceChecker.isTable(tableOrName)
            ? tableOrName
            : await this.getCachedTable(tableOrName);
        const up = this.dropPrimaryKeySql(table);
        const down = this.createPrimaryKeySql(table, table.primaryColumns.map((column) => column.name), constraintName);
        await this.executeQueries(up, down);
        table.primaryColumns.forEach((column) => {
            column.isPrimary = false;
        });
    }
    /**
     * Creates a new unique constraint.
     */
    async createUniqueConstraint(tableOrName, uniqueConstraint) {
        const table = InstanceChecker_1.InstanceChecker.isTable(tableOrName)
            ? tableOrName
            : await this.getCachedTable(tableOrName);
        // new unique constraint may be passed without name. In this case we generate unique name manually.
        if (!uniqueConstraint.name)
            uniqueConstraint.name =
                this.connection.namingStrategy.uniqueConstraintName(table, uniqueConstraint.columnNames);
        const up = this.createUniqueConstraintSql(table, uniqueConstraint);
        const down = this.dropUniqueConstraintSql(table, uniqueConstraint);
        await this.executeQueries(up, down);
        table.addUniqueConstraint(uniqueConstraint);
    }
    /**
     * Creates a new unique constraints.
     */
    async createUniqueConstraints(tableOrName, uniqueConstraints) {
        for (const uniqueConstraint of uniqueConstraints) {
            await this.createUniqueConstraint(tableOrName, uniqueConstraint);
        }
    }
    /**
     * Drops an unique constraint.
     */
    async dropUniqueConstraint(tableOrName, uniqueOrName) {
        const table = InstanceChecker_1.InstanceChecker.isTable(tableOrName)
            ? tableOrName
            : await this.getCachedTable(tableOrName);
        const uniqueConstraint = InstanceChecker_1.InstanceChecker.isTableUnique(uniqueOrName)
            ? uniqueOrName
            : table.uniques.find((u) => u.name === uniqueOrName);
        if (!uniqueConstraint)
            throw new TypeORMError_1.TypeORMError(`Supplied unique constraint was not found in table ${table.name}`);
        const up = this.dropUniqueConstraintSql(table, uniqueConstraint);
        const down = this.createUniqueConstraintSql(table, uniqueConstraint);
        await this.executeQueries(up, down);
        table.removeUniqueConstraint(uniqueConstraint);
    }
    /**
     * Drops an unique constraints.
     */
    async dropUniqueConstraints(tableOrName, uniqueConstraints) {
        for (const uniqueConstraint of uniqueConstraints) {
            await this.dropUniqueConstraint(tableOrName, uniqueConstraint);
        }
    }
    /**
     * Creates a new check constraint.
     */
    async createCheckConstraint(tableOrName, checkConstraint) {
        const table = InstanceChecker_1.InstanceChecker.isTable(tableOrName)
            ? tableOrName
            : await this.getCachedTable(tableOrName);
        // new unique constraint may be passed without name. In this case we generate unique name manually.
        if (!checkConstraint.name)
            checkConstraint.name =
                this.connection.namingStrategy.checkConstraintName(table, checkConstraint.expression);
        const up = this.createCheckConstraintSql(table, checkConstraint);
        const down = this.dropCheckConstraintSql(table, checkConstraint);
        await this.executeQueries(up, down);
        table.addCheckConstraint(checkConstraint);
    }
    /**
     * Creates a new check constraints.
     */
    async createCheckConstraints(tableOrName, checkConstraints) {
        for (const checkConstraint of checkConstraints) {
            await this.createCheckConstraint(tableOrName, checkConstraint);
        }
    }
    /**
     * Drops check constraint.
     */
    async dropCheckConstraint(tableOrName, checkOrName) {
        const table = InstanceChecker_1.InstanceChecker.isTable(tableOrName)
            ? tableOrName
            : await this.getCachedTable(tableOrName);
        const checkConstraint = InstanceChecker_1.InstanceChecker.isTableCheck(checkOrName)
            ? checkOrName
            : table.checks.find((c) => c.name === checkOrName);
        if (!checkConstraint)
            throw new TypeORMError_1.TypeORMError(`Supplied check constraint was not found in table ${table.name}`);
        const up = this.dropCheckConstraintSql(table, checkConstraint);
        const down = this.createCheckConstraintSql(table, checkConstraint);
        await this.executeQueries(up, down);
        table.removeCheckConstraint(checkConstraint);
    }
    /**
     * Drops check constraints.
     */
    async dropCheckConstraints(tableOrName, checkConstraints) {
        for (const checkConstraint of checkConstraints) {
            await this.dropCheckConstraint(tableOrName, checkConstraint);
        }
    }
    /**
     * Creates a new exclusion constraint.
     */
    async createExclusionConstraint(tableOrName, exclusionConstraint) {
        throw new TypeORMError_1.TypeORMError(`Dameng does not support exclusion constraints.`);
    }
    /**
     * Creates a new exclusion constraints.
     */
    async createExclusionConstraints(tableOrName, exclusionConstraints) {
        throw new TypeORMError_1.TypeORMError(`Dameng does not support exclusion constraints.`);
    }
    /**
     * Drops exclusion constraint.
     */
    async dropExclusionConstraint(tableOrName, exclusionOrName) {
        throw new TypeORMError_1.TypeORMError(`Dameng does not support exclusion constraints.`);
    }
    /**
     * Drops exclusion constraints.
     */
    async dropExclusionConstraints(tableOrName, exclusionConstraints) {
        throw new TypeORMError_1.TypeORMError(`Dameng does not support exclusion constraints.`);
    }
    /**
     * Creates a new foreign key.
     */
    async createForeignKey(tableOrName, foreignKey) {
        const table = InstanceChecker_1.InstanceChecker.isTable(tableOrName)
            ? tableOrName
            : await this.getCachedTable(tableOrName);
        // new FK may be passed without name. In this case we generate FK name manually.
        if (!foreignKey.name)
            foreignKey.name = this.connection.namingStrategy.foreignKeyName(table, foreignKey.columnNames, this.getTablePath(foreignKey), foreignKey.referencedColumnNames);
        const up = this.createForeignKeySql(table, foreignKey);
        const down = this.dropForeignKeySql(table, foreignKey);
        await this.executeQueries(up, down);
        table.addForeignKey(foreignKey);
    }
    /**
     * Creates a new foreign keys.
     */
    async createForeignKeys(tableOrName, foreignKeys) {
        for (const foreignKey of foreignKeys) {
            await this.createForeignKey(tableOrName, foreignKey);
        }
    }
    /**
     * Drops a foreign key.
     */
    async dropForeignKey(tableOrName, foreignKeyOrName) {
        const table = InstanceChecker_1.InstanceChecker.isTable(tableOrName)
            ? tableOrName
            : await this.getCachedTable(tableOrName);
        const foreignKey = InstanceChecker_1.InstanceChecker.isTableForeignKey(foreignKeyOrName)
            ? foreignKeyOrName
            : table.foreignKeys.find((fk) => fk.name === foreignKeyOrName);
        if (!foreignKey)
            throw new TypeORMError_1.TypeORMError(`Supplied foreign key was not found in table ${table.name}`);
        const up = this.dropForeignKeySql(table, foreignKey);
        const down = this.createForeignKeySql(table, foreignKey);
        await this.executeQueries(up, down);
        table.removeForeignKey(foreignKey);
    }
    /**
     * Drops a foreign keys from the table.
     */
    async dropForeignKeys(tableOrName, foreignKeys) {
        for (const foreignKey of foreignKeys) {
            await this.dropForeignKey(tableOrName, foreignKey);
        }
    }
    /**
     * Creates a new index.
     */
    async createIndex(tableOrName, index) {
        const table = InstanceChecker_1.InstanceChecker.isTable(tableOrName)
            ? tableOrName
            : await this.getCachedTable(tableOrName);
        // new index may be passed without name. In this case we generate index name manually.
        if (!index.name)
            index.name = this.generateIndexName(table, index);
        const up = this.createIndexSql(table, index);
        const down = this.dropIndexSql(table, index);
        await this.executeQueries(up, down);
        table.addIndex(index, true);
    }
    /**
     * Creates a new indices
     */
    async createIndices(tableOrName, indices) {
        for (const index of indices) {
            await this.createIndex(tableOrName, index);
        }
    }
    /**
     * Drops an index.
     */
    async dropIndex(tableOrName, indexOrName) {
        const table = InstanceChecker_1.InstanceChecker.isTable(tableOrName)
            ? tableOrName
            : await this.getCachedTable(tableOrName);
        const index = InstanceChecker_1.InstanceChecker.isTableIndex(indexOrName)
            ? indexOrName
            : table.indices.find((i) => i.name === indexOrName);
        if (!index)
            throw new TypeORMError_1.TypeORMError(`Supplied index ${indexOrName} was not found in table ${table.name}`);
        // old index may be passed without name. In this case we generate index name manually.
        if (!index.name)
            index.name = this.generateIndexName(table, index);
        const up = this.dropIndexSql(table, index);
        const down = this.createIndexSql(table, index);
        await this.executeQueries(up, down);
        table.removeIndex(index, true);
    }
    /**
     * Drops an indices from the table.
     */
    async dropIndices(tableOrName, indices) {
        for (const index of indices) {
            await this.dropIndex(tableOrName, index);
        }
    }
    /**
     * Clears all table contents.
     * Note: this operation uses SQL's TRUNCATE query which cannot be reverted in transactions.
     */
    async clearTable(tableOrName) {
        await this.query(`TRUNCATE TABLE ${this.escapePath(tableOrName)}`);
    }
    /**
     * Removes all tables from the currently connected database.
     * Be careful using this method and avoid using it in production or migrations
     * (because it can clear all your database).
     */
    async clearDatabase(database) {
        const schemaName = database || this.driver.schema;
        if (!await this.hasSchema(schemaName)) {
            return;
        }
        const isAnotherTransactionActive = this.isTransactionActive;
        if (!isAnotherTransactionActive)
            await this.startTransaction();
        try {
            // drop views
            const dropViewsQuery = `SELECT 'DROP VIEW "${schemaName}"."' || TABS.NAME || '"' AS "query" FROM
                (SELECT ID, PID FROM SYS.SYSOBJECTS WHERE TYPE$ = 'SCH' AND NAME = '${schemaName}') SCHEMAS,
                (SELECT ID, SCHID, NAME FROM SYS.SYSOBJECTS WHERE TYPE$ = 'SCHOBJ' AND SUBTYPE$ = 'VIEW' AND
                INFO1 & 0x001FFFE0 = 0) TABS
                WHERE TABS.SCHID = SCHEMAS.ID AND SF_CHECK_PRIV_OPT(UID(), CURRENT_USERTYPE(), TABS.ID, SCHEMAS.PID, -1, TABS.ID) = 1`;
            const dropViewQueries = await this.query(dropViewsQuery);
            // 不可以并发执行，见bug648855，下同
            for (const query of dropViewQueries) {
                await this.query(query["query"]);
            }
            // drop materialized views
            const dropMatViewsQuery = `SELECT 'DROP MATERIALIZED VIEW "${schemaName}"."' || TABS.NAME || '"' AS "query" FROM
                (SELECT ID, PID FROM SYS.SYSOBJECTS WHERE TYPE$ = 'SCH' AND NAME = '${schemaName}') SCHEMAS,
                (SELECT ID, SCHID, NAME FROM SYS.SYSOBJECTS WHERE TYPE$ = 'SCHOBJ' AND SUBTYPE$ = 'VIEW' AND
                INFO1 & 0x001FFFE0 != 0) TABS
                WHERE TABS.SCHID = SCHEMAS.ID AND SF_CHECK_PRIV_OPT(UID(), CURRENT_USERTYPE(), TABS.ID, SCHEMAS.PID, -1, TABS.ID) = 1`;
            const dropMatViewQueries = await this.query(dropMatViewsQuery);
            for (const query of dropMatViewQueries) {
                await this.query(query["query"]);
            }
            // drop tables
            // INFO3 & 0x003F not in (0x0A, 0x20) 消除位图链接索引表和位图索引表
            // INFO3&0x100000 != 0x100000 AND INFO3&0x200000 != 0x200000 AND INFO3&0x100000000 = 0 消除物化视图日志表和物化视图数据表和内部表
            //  NAME NOT LIKE 'CTI$%$_' '%$AUX' '%$_AUX' '%$ALOG' 'BIN$%' 消除全文链接、HUGE、高级日志辅助表
            const dropTablesQuery = `SELECT 'DROP TABLE "${schemaName}"."' || TABS.NAME || '" CASCADE CONSTRAINTS' AS "query" FROM 
                (SELECT ID, PID FROM SYS.SYSOBJECTS WHERE TYPE$ = 'SCH' AND NAME = '${schemaName}') SCHEMAS,
                (SELECT ID, SCHID, NAME FROM SYS.SYSOBJECTS WHERE TYPE$ = 'SCHOBJ' AND
                (SUBTYPE$ ='UTAB' AND CAST((INFO3 & 0x003F) AS INT) not in (9, 27, 29, 25, 12, 7, 21, 23, 18, 5, 0x0A, 0x20, 13) AND
                INFO3&0x100000 != 0x100000 AND INFO3&0x200000 != 0x200000 AND INFO3&0x100000000 = 0 AND
                NAME NOT LIKE 'CTI$%$_' AND NAME NOT LIKE '%$AUX' AND NAME NOT LIKE '%$_AUX' AND
                NAME NOT LIKE '%$ALOG' AND NAME NOT LIKE 'BIN$%')) TABS
                WHERE TABS.SCHID = SCHEMAS.ID AND SF_CHECK_PRIV_OPT(UID(), CURRENT_USERTYPE(), TABS.ID, SCHEMAS.PID, -1, TABS.ID) = 1`;
            const dropTableQueries = await this.query(dropTablesQuery);
            for (const query of dropTableQueries) {
                await this.query(query["query"]);
            }
            if (!isAnotherTransactionActive)
                await this.commitTransaction();
        }
        catch (error) {
            try {
                // we throw original error even if rollback thrown an error
                if (!isAnotherTransactionActive)
                    await this.rollbackTransaction();
            }
            catch (rollbackError) { }
            throw error;
        }
    }
    // -------------------------------------------------------------------------
    // Protected Methods
    // -------------------------------------------------------------------------
    async loadViews(viewNames) {
        const hasTable = await this.hasTable(this.getTypeormMetadataTableName());
        if (!hasTable) {
            return [];
        }
        if (!viewNames) {
            viewNames = [];
        }
        const currentSchema = await this.getCurrentSchema();
        const viewsCondition = viewNames
            .map((viewName) => this.driver.parseTableName(viewName))
            .map(({ schema, tableName }) => {
            if (!schema) {
                schema = this.driver.options.schema || currentSchema;
            }
            return `("T"."schema" = '${schema}' AND "T"."name" = '${tableName}')`;
        })
            .join(" OR ");
        let query = `SELECT "T".* FROM ${this.escapePath(this.getTypeormMetadataTableName())} "T" ` +
            `INNER JOIN "USER_OBJECTS" "O" ON "O"."OBJECT_NAME" = "T"."name" AND "O"."OBJECT_TYPE" IN ( 'MATERIALIZED VIEW', 'VIEW' ) ` +
            `WHERE "T"."type" IN ('${MetadataTableType_1.MetadataTableType.MATERIALIZED_VIEW}', '${MetadataTableType_1.MetadataTableType.VIEW}')`;
        if (viewsCondition.length > 0)
            query += ` AND ${viewsCondition}`;
        const dbViews = await this.query(query);
        return dbViews.map((dbView) => {
            const view = new View_1.View();
            view.database = dbView["database"];
            view.schema = dbView["schema"] || currentSchema;
            view.name = dbView["name"];
            view.expression = dbView["value"];
            view.materialized =
                dbView["type"] === MetadataTableType_1.MetadataTableType.MATERIALIZED_VIEW;
            return view;
        });
    }
    /**
     * Loads all tables (with given names) from the database and creates a Table from them.
     */
    async loadTables(tableNames) {
        if (tableNames && tableNames.length === 0) {
            return [];
        }
        const dbTables = [];
        const currentSchema = await this.getCurrentSchema();
        if (!tableNames) {
            const tablesSql = `SELECT "TABLE_NAME", "OWNER" FROM "ALL_TABLES"`;
            dbTables.push(...(await this.query(tablesSql)));
        }
        else {
            const tablesCondition = tableNames
                .map((tableName) => {
                const parts = tableName.split(".");
                if (parts.length >= 3) {
                    const [, schema, name] = parts;
                    return `("OWNER" = '${schema}' AND "TABLE_NAME" = '${name}')`;
                }
                else if (parts.length === 2) {
                    const [schema, name] = parts;
                    return `("OWNER" = '${schema}' AND "TABLE_NAME" = '${name}')`;
                }
                else if (parts.length === 1) {
                    const [name] = parts;
                    return `("OWNER" = '${currentSchema}' AND "TABLE_NAME" = '${name}')`;
                }
                else {
                    return `(1=0)`;
                }
            })
                .join(" OR ");
            const tablesSql = `SELECT "TABLE_NAME", "OWNER" FROM "ALL_TABLES" WHERE ${tablesCondition}`;
            dbTables.push(...(await this.query(tablesSql)));
        }
        // if tables were not found in the db, no need to proceed
        if (dbTables.length === 0) {
            return [];
        }
        // load tables, columns, indices and foreign keys
        const columnsCondition1 = dbTables
            .map(({ TABLE_NAME, OWNER }) => {
            return `("SCH"."NAME" = '${OWNER}' AND "TAB"."NAME" = '${TABLE_NAME}')`;
        })
            .join(" OR ");
        const columnsCondition2 = dbTables
            .map(({ TABLE_NAME, OWNER }) => {
            return `("C"."OWNER" = '${OWNER}' AND "C"."TABLE_NAME" = '${TABLE_NAME}')`;
        })
            .join(" OR ");
        // ALL_TAB_COLS有误，直接使用SYSCOLUMNS自己计算
        const columnsSql = `SELECT "SCH"."NAME" "OWNER", "TAB"."NAME" "TABLE_NAME", "C"."NAME" "COLUMN_NAME",
            (CASE WHEN "CI"."INFO1" IS NULL OR ((("CI"."INFO1">>2) & 0x01)=0 AND (("CI"."INFO1">>3) & 0x01)=0) THEN "C"."TYPE$"
                WHEN ("CI"."INFO2" & 0xFF) = 0 THEN 'NUMBER' WHEN (("CI"."INFO1">>3) & 0x01)=1 THEN 'DATE' ELSE 'FLOAT' END) "DATA_TYPE",
            "C"."LENGTH$" "DATA_LENGTH",
            (CASE WHEN POSITION('INTERVAL', "C"."TYPE$") > 0 THEN (("C"."SCALE" & 0XF0)>>4)
                WHEN "CI"."INFO1" IS NOT NULL AND (("CI"."INFO1">>2)&0x01) = 0x01 THEN ("CI"."INFO2" & 0xFF)
                WHEN "C"."LENGTH$"=0 THEN NULL
                ELSE "C"."LENGTH$" END) "DATA_PRECISION",
            (CASE WHEN POSITION('INTERVAL', "C"."TYPE$") > 0 OR POSITION('WITH LOCAL TIME ZONE', "C"."TYPE$") > 0 THEN ("C"."SCALE" & 0X0F)
                WHEN "C"."SCALE"=0 THEN NULL
                ELSE "C"."SCALE" END) "DATA_SCALE",
            "C"."NULLABLE$" "NULLABLE", "C"."DEFVAL" "DATA_DEFAULT", "C"."LENGTH$" "CHAR_COL_DECL_LENGTH",
            CAST((CASE WHEN "CI"."INFO1" IS NOT NULL AND "CI"."INFO1"&0x01 = 0x01 THEN 'YES' ELSE 'NO' END) AS VARCHAR(3)) "VIRTUAL_COLUMN",
            if("C"."INFO2" & 0x01 = 0x01, 'Y', 'N') "IDENTITY_COLUMN", "CM"."COMMENT$" "COMMENT"
            FROM "SYSCOLUMNS" "C"
            LEFT JOIN "SYSCOLINFOS" "CI" ON "CI"."ID"="C"."ID" AND "CI"."COLID"="C"."COLID"
            LEFT JOIN "SYSOBJECTS" "TAB" ON "TAB"."ID"="C"."ID"
            LEFT JOIN "SYSOBJECTS" "SCH" ON "SCH"."ID"="TAB"."SCHID"
            LEFT JOIN "SYSCOLUMNCOMMENTS" "CM" ON "CM"."SCHNAME"="SCH"."NAME" AND "CM"."TVNAME"="TAB"."NAME" AND "CM"."COLNAME"="C"."NAME"
            WHERE (${columnsCondition1})`;
        // 本可以直接使用 "C"."GENERATED" = 'N' 去除系统索引，但bug648601不支持，所以只能像下面那样join sysindexes
        // const indicesSql =
        //     `SELECT "C"."INDEX_NAME", "C"."OWNER", "C"."TABLE_NAME", "C"."UNIQUENESS", ` +
        //     `LISTAGG ("COL"."COLUMN_NAME", ',') WITHIN GROUP (ORDER BY "COL"."COLUMN_NAME") AS "COLUMN_NAMES" ` +
        //     `FROM "ALL_INDEXES" "C" ` +
        //     `INNER JOIN "ALL_IND_COLUMNS" "COL" ON "COL"."INDEX_OWNER" = "C"."OWNER" AND "COL"."INDEX_NAME" = "C"."INDEX_NAME" ` +
        //     `LEFT JOIN "ALL_CONSTRAINTS" "CON" ON "CON"."OWNER" = "C"."OWNER" AND "CON"."CONSTRAINT_NAME" = "C"."INDEX_NAME" ` +
        //     `WHERE (${columnsCondition}) AND "C"."GENERATED" = 'N' AND "CON"."CONSTRAINT_NAME" IS NULL ` +
        //     `GROUP BY "C"."INDEX_NAME", "C"."OWNER", "C"."TABLE_NAME", "C"."UNIQUENESS"`
        const indicesSql = `SELECT "C"."INDEX_NAME", "C"."OWNER", "C"."TABLE_NAME", "C"."UNIQUENESS", ` +
            `LISTAGG ("COL"."COLUMN_NAME", ',') WITHIN GROUP (ORDER BY "COL"."COLUMN_NAME") AS "COLUMN_NAMES" ` +
            `FROM "ALL_INDEXES" "C" ` +
            `INNER JOIN "ALL_IND_COLUMNS" "COL" ON "COL"."INDEX_OWNER" = "C"."OWNER" AND "COL"."INDEX_NAME" = "C"."INDEX_NAME" ` +
            `LEFT JOIN "ALL_CONSTRAINTS" "CON" ON "CON"."OWNER" = "C"."OWNER" AND "CON"."CONSTRAINT_NAME" = "C"."INDEX_NAME" ` +
            `LEFT JOIN "SYSOBJECTS" "OBJ" ON "OBJ"."NAME" = "C"."INDEX_NAME" ` +
            `LEFT JOIN "SYSINDEXES" "SIDX" ON "SIDX"."ID" = "OBJ"."ID" ` +
            `WHERE (${columnsCondition2}) AND "SIDX"."FLAG" & 0X01 != 1 AND "C"."GENERATED" = 'N' AND "CON"."CONSTRAINT_NAME" IS NULL ` +
            `GROUP BY "C"."INDEX_NAME", "C"."OWNER", "C"."TABLE_NAME", "C"."UNIQUENESS"`;
        const foreignKeysSql = `SELECT "C"."CONSTRAINT_NAME", "C"."OWNER", "C"."TABLE_NAME", "COL"."COLUMN_NAME", "REF_COL"."TABLE_NAME" AS "REFERENCED_TABLE_NAME", ` +
            `"REF_COL"."COLUMN_NAME" AS "REFERENCED_COLUMN_NAME", "C"."DELETE_RULE" AS "ON_DELETE" ` +
            `FROM "ALL_CONSTRAINTS" "C" ` +
            `INNER JOIN "ALL_CONS_COLUMNS" "COL" ON "COL"."OWNER" = "C"."OWNER" AND "COL"."CONSTRAINT_NAME" = "C"."CONSTRAINT_NAME" ` +
            `INNER JOIN "ALL_CONS_COLUMNS" "REF_COL" ON "REF_COL"."OWNER" = "C"."R_OWNER" AND "REF_COL"."CONSTRAINT_NAME" = "C"."R_CONSTRAINT_NAME" AND "REF_COL"."POSITION" = "COL"."POSITION" ` +
            `WHERE (${columnsCondition2}) AND "C"."CONSTRAINT_TYPE" = 'R'`;
        const constraintsSql = `SELECT "C"."CONSTRAINT_NAME", "C"."CONSTRAINT_TYPE", "C"."OWNER", "C"."TABLE_NAME", "COL"."COLUMN_NAME", "C"."SEARCH_CONDITION" ` +
            `FROM "ALL_CONSTRAINTS" "C" ` +
            `INNER JOIN "ALL_CONS_COLUMNS" "COL" ON "COL"."OWNER" = "C"."OWNER" AND "COL"."CONSTRAINT_NAME" = "C"."CONSTRAINT_NAME" ` +
            `WHERE (${columnsCondition2}) AND "C"."CONSTRAINT_TYPE" IN ('C', 'U', 'P')`; // AND "C"."GENERATED" = 'USER NAME'`
        const dbColumns = await this.query(columnsSql);
        const dbIndices = await this.query(indicesSql);
        const dbForeignKeys = await this.query(foreignKeysSql);
        const dbConstraints = await this.query(constraintsSql);
        let tables = [];
        // create tables for loaded tables
        for (const dbTable of dbTables) {
            const table = new Table_1.Table();
            const owner = dbTable["OWNER"] === currentSchema &&
                (!this.driver.options.schema ||
                    this.driver.options.schema === currentSchema)
                ? undefined
                : dbTable["OWNER"];
            table.schema = dbTable["OWNER"];
            table.name = this.driver.buildTableName(dbTable["TABLE_NAME"], owner);
            // create columns from the loaded columns
            table.columns = await Promise.all(dbColumns
                .filter((dbColumn) => dbColumn["OWNER"] === dbTable["OWNER"] &&
                dbColumn["TABLE_NAME"] ===
                    dbTable["TABLE_NAME"] &&
                // Filter out auto-generated virtual columns,
                // since TypeORM will have no info about them.
                !(dbColumn["VIRTUAL_COLUMN"] === "YES" &&
                    dbColumn["USER_GENERATED"] === "NO"))
                .map(async (dbColumn) => {
                const columnConstraints = dbConstraints.filter((dbConstraint) => dbConstraint["OWNER"] ===
                    dbColumn["OWNER"] &&
                    dbConstraint["TABLE_NAME"] ===
                        dbColumn["TABLE_NAME"] &&
                    dbConstraint["COLUMN_NAME"] ===
                        dbColumn["COLUMN_NAME"]);
                const uniqueConstraints = columnConstraints.filter((constraint) => constraint["CONSTRAINT_TYPE"] === "U");
                const isConstraintComposite = uniqueConstraints.every((uniqueConstraint) => {
                    return dbConstraints.some((dbConstraint) => dbConstraint["OWNER"] ===
                        dbColumn["OWNER"] &&
                        dbConstraint["TABLE_NAME"] ===
                            dbColumn["TABLE_NAME"] &&
                        dbConstraint["COLUMN_NAME"] !==
                            dbColumn["COLUMN_NAME"] &&
                        dbConstraint["CONSTRAINT_NAME"] ===
                            uniqueConstraint["CONSTRAINT_NAME"] &&
                        dbConstraint["CONSTRAINT_TYPE"] ===
                            "U");
                });
                const tableColumn = new TableColumn_1.TableColumn();
                tableColumn.name = dbColumn["COLUMN_NAME"];
                tableColumn.type =
                    dbColumn["DATA_TYPE"].toLowerCase();
                if (tableColumn.type.indexOf("(") !== -1)
                    tableColumn.type = tableColumn.type.replace(/\([0-9]*\)/, "");
                // check only columns that have length property
                if (this.driver.withLengthColumnTypes.indexOf(tableColumn.type) !== -1) {
                    const length = tableColumn.type === "raw"
                        ? dbColumn["DATA_LENGTH"]
                        : dbColumn["CHAR_COL_DECL_LENGTH"];
                    tableColumn.length =
                        length &&
                            !this.isDefaultColumnLength(table, tableColumn, length)
                            ? length.toString()
                            : "";
                }
                if (tableColumn.type === "decimal" ||
                    tableColumn.type === "dec" ||
                    tableColumn.type === "numeric" ||
                    tableColumn.type === "number" ||
                    tableColumn.type === "float") {
                    if (dbColumn["DATA_PRECISION"] !== null &&
                        !this.isDefaultColumnPrecision(table, tableColumn, dbColumn["DATA_PRECISION"]))
                        tableColumn.precision =
                            dbColumn["DATA_PRECISION"];
                    if (dbColumn["DATA_SCALE"] !== null &&
                        !this.isDefaultColumnScale(table, tableColumn, dbColumn["DATA_SCALE"]))
                        tableColumn.scale = dbColumn["DATA_SCALE"];
                }
                else if ((tableColumn.type === "time" ||
                    tableColumn.type === "timestamp" ||
                    tableColumn.type === "datetime" ||
                    tableColumn.type ===
                        "timestamp with time zone" ||
                    tableColumn.type ===
                        "datetime with time zone" ||
                    tableColumn.type ===
                        "timestamp with local time zone" ||
                    tableColumn.type ===
                        "datetime with local time zone") &&
                    dbColumn["DATA_SCALE"] !== null) {
                    tableColumn.precision =
                        !this.isDefaultColumnPrecision(table, tableColumn, dbColumn["DATA_SCALE"])
                            ? dbColumn["DATA_SCALE"]
                            : undefined;
                }
                if (tableColumn.type === "varchar") {
                    // check if this is an enum
                    const columnEnumConstraints = columnConstraints.filter((constraint) => constraint["CONSTRAINT_TYPE"] === "C"
                        && this.isEnumCheckConstraint(constraint["CONSTRAINT_NAME"])
                        && constraint["SEARCH_CONDITION"].startsWith(`"${tableColumn.name}"`));
                    if (columnEnumConstraints.length) {
                        const checkConstraint = columnEnumConstraints[0];
                        // make column into an enum
                        tableColumn.enum = [];
                        // '"C1" IN ('A', 'B', 'C')' => 'A', 'B', 'C'
                        const enumValueRegexp = new RegExp("'([^']+)'[,|\)]", //end with , or )
                        "g");
                        let result;
                        while ((result = enumValueRegexp.exec(checkConstraint["SEARCH_CONDITION"])) !== null) {
                            tableColumn.enum.push(result[1]);
                        }
                    }
                }
                tableColumn.default =
                    dbColumn["DATA_DEFAULT"] !== null &&
                        dbColumn["DATA_DEFAULT"] !== undefined &&
                        dbColumn["VIRTUAL_COLUMN"] === "NO" &&
                        dbColumn["DATA_DEFAULT"].trim() !== "NULL"
                        ? (tableColumn.default =
                            dbColumn["DATA_DEFAULT"].trim())
                        : undefined;
                const primaryConstraint = columnConstraints.find((constraint) => constraint["CONSTRAINT_TYPE"] === "P");
                if (primaryConstraint) {
                    tableColumn.isPrimary = true;
                    // find another columns involved in primary key constraint
                    const anotherPrimaryConstraints = dbConstraints.filter((constraint) => constraint["OWNER"] ===
                        dbColumn["OWNER"] &&
                        constraint["TABLE_NAME"] ===
                            dbColumn["TABLE_NAME"] &&
                        constraint["COLUMN_NAME"] !==
                            dbColumn["COLUMN_NAME"] &&
                        constraint["CONSTRAINT_TYPE"] ===
                            "P");
                    // collect all column names
                    const columnNames = anotherPrimaryConstraints.map((constraint) => constraint["COLUMN_NAME"]);
                    columnNames.push(dbColumn["COLUMN_NAME"]);
                    // build default primary key constraint name
                    const pkName = this.connection.namingStrategy.primaryKeyName(table, columnNames);
                    // if primary key has user-defined constraint name, write it in table column
                    if (primaryConstraint["CONSTRAINT_NAME"] !==
                        pkName) {
                        tableColumn.primaryKeyConstraintName =
                            primaryConstraint["CONSTRAINT_NAME"];
                    }
                }
                tableColumn.isNullable =
                    dbColumn["NULLABLE"] === "Y";
                tableColumn.isUnique =
                    uniqueConstraints.length > 0 &&
                        !isConstraintComposite;
                tableColumn.isGenerated =
                    dbColumn["IDENTITY_COLUMN"] === "Y"; // === "YES"
                if (tableColumn.isGenerated) {
                    tableColumn.generationStrategy = "increment";
                    tableColumn.default = undefined;
                }
                tableColumn.comment =
                    dbColumn["COMMENT"] == null
                        ? undefined
                        : dbColumn["COMMENT"];
                if (dbColumn["VIRTUAL_COLUMN"] === "YES") {
                    tableColumn.generatedType = "VIRTUAL";
                    const asExpressionQuery = this.selectTypeormMetadataSql({
                        table: dbTable["TABLE_NAME"],
                        type: MetadataTableType_1.MetadataTableType.GENERATED_COLUMN,
                        name: tableColumn.name,
                    });
                    const results = await this.query(asExpressionQuery.query, asExpressionQuery.parameters);
                    if (results[0] && results[0].value) {
                        tableColumn.asExpression = results[0].value;
                    }
                    else {
                        tableColumn.asExpression = "";
                    }
                }
                return tableColumn;
            }));
            // find unique constraints of table, group them by constraint name and build TableUnique.
            const tableUniqueConstraints = OrmUtils_1.OrmUtils.uniq(dbConstraints.filter((dbConstraint) => {
                return (dbConstraint["TABLE_NAME"] ===
                    dbTable["TABLE_NAME"] &&
                    dbConstraint["OWNER"] === dbTable["OWNER"] &&
                    dbConstraint["CONSTRAINT_TYPE"] === "U");
            }), (dbConstraint) => dbConstraint["CONSTRAINT_NAME"]);
            table.uniques = tableUniqueConstraints.map((constraint) => {
                const uniques = dbConstraints.filter((dbC) => dbC["CONSTRAINT_NAME"] ===
                    constraint["CONSTRAINT_NAME"]);
                return new TableUnique_1.TableUnique({
                    name: constraint["CONSTRAINT_NAME"],
                    columnNames: uniques.map((u) => u["COLUMN_NAME"]),
                });
            });
            // find check constraints of table, group them by constraint name and build TableCheck.
            const tableCheckConstraints = OrmUtils_1.OrmUtils.uniq(dbConstraints.filter((dbConstraint) => {
                return (dbConstraint["TABLE_NAME"] ===
                    dbTable["TABLE_NAME"] &&
                    dbConstraint["OWNER"] === dbTable["OWNER"] &&
                    dbConstraint["CONSTRAINT_TYPE"] === "C");
            }), (dbConstraint) => dbConstraint["CONSTRAINT_NAME"]);
            table.checks = tableCheckConstraints.filter((constraint) => !this.isEnumCheckConstraint(constraint["CONSTRAINT_NAME"])).map((constraint) => {
                const checks = dbConstraints.filter((dbC) => dbC["TABLE_NAME"] === constraint["TABLE_NAME"] &&
                    dbC["OWNER"] === constraint["OWNER"] &&
                    dbC["CONSTRAINT_NAME"] ===
                        constraint["CONSTRAINT_NAME"]);
                return new TableCheck_1.TableCheck({
                    name: constraint["CONSTRAINT_NAME"],
                    columnNames: checks.map((c) => c["COLUMN_NAME"]),
                    expression: constraint["SEARCH_CONDITION"],
                });
            });
            // find foreign key constraints of table, group them by constraint name and build TableForeignKey.
            const tableForeignKeyConstraints = OrmUtils_1.OrmUtils.uniq(dbForeignKeys.filter((dbForeignKey) => dbForeignKey["OWNER"] === dbTable["OWNER"] &&
                dbForeignKey["TABLE_NAME"] ===
                    dbTable["TABLE_NAME"]), (dbForeignKey) => dbForeignKey["CONSTRAINT_NAME"]);
            table.foreignKeys = tableForeignKeyConstraints.map((dbForeignKey) => {
                const foreignKeys = dbForeignKeys.filter((dbFk) => dbFk["TABLE_NAME"] ===
                    dbForeignKey["TABLE_NAME"] &&
                    dbFk["OWNER"] === dbForeignKey["OWNER"] &&
                    dbFk["CONSTRAINT_NAME"] ===
                        dbForeignKey["CONSTRAINT_NAME"]);
                return new TableForeignKey_1.TableForeignKey({
                    name: dbForeignKey["CONSTRAINT_NAME"],
                    columnNames: foreignKeys.map((dbFk) => dbFk["COLUMN_NAME"]),
                    referencedDatabase: table.database,
                    referencedSchema: dbForeignKey["OWNER"],
                    referencedTableName: dbForeignKey["REFERENCED_TABLE_NAME"],
                    referencedColumnNames: foreignKeys.map((dbFk) => dbFk["REFERENCED_COLUMN_NAME"]),
                    onDelete: dbForeignKey["ON_DELETE"],
                    onUpdate: "NO ACTION", // Oracle does not have onUpdate option in FK's, but we need it for proper synchronization
                });
            });
            // Attempt to map auto-generated virtual columns to their
            // referenced columns, through its 'DATA_DEFAULT' property.
            //
            // An example of this happening is when a column of type
            // TIMESTAMP WITH TIME ZONE is indexed. Oracle will create a
            // virtual column of type TIMESTAMP with a default value of
            // SYS_EXTRACT_UTC(<column>).
            const autoGenVirtualDbColumns = dbColumns
                .filter((dbColumn) => dbColumn["OWNER"] === dbTable["OWNER"] &&
                dbColumn["TABLE_NAME"] === dbTable["TABLE_NAME"] &&
                dbColumn["VIRTUAL_COLUMN"] === "YES" &&
                dbColumn["USER_GENERATED"] === "NO")
                .reduce((acc, x) => {
                const referencedDbColumn = dbColumns.find((dbColumn) => x["DATA_DEFAULT"].includes(dbColumn["COLUMN_NAME"]));
                if (!referencedDbColumn)
                    return acc;
                return {
                    ...acc,
                    [x["COLUMN_NAME"]]: referencedDbColumn["COLUMN_NAME"],
                };
            }, {});
            // create TableIndex objects from the loaded indices
            table.indices = dbIndices
                .filter((dbIndex) => dbIndex["TABLE_NAME"] === dbTable["TABLE_NAME"] &&
                dbIndex["OWNER"] === dbTable["OWNER"])
                .map((dbIndex) => {
                //
                const columnNames = dbIndex["COLUMN_NAMES"]
                    .split(",")
                    .map((columnName) => autoGenVirtualDbColumns[columnName] ??
                    columnName);
                return new TableIndex_1.TableIndex({
                    name: dbIndex["INDEX_NAME"],
                    columnNames,
                    isUnique: dbIndex["UNIQUENESS"] === "UNIQUE",
                });
            });
            tables.push(table);
        }
        return tables;
    }
    /**
     * Builds create table sql
     */
    createTableSql(table, createForeignKeys) {
        const columnDefinitions = table.columns
            .map((column) => this.buildCreateColumnSql(table, column, false, false))
            .join(", ");
        let sql = `CREATE TABLE ${this.escapePath(table)} (${columnDefinitions}`;
        table.columns
            .filter((column) => column.isUnique)
            .forEach((column) => {
            const isUniqueExist = table.uniques.some((unique) => unique.columnNames.length === 1 &&
                unique.columnNames[0] === column.name);
            if (!isUniqueExist)
                table.uniques.push(new TableUnique_1.TableUnique({
                    name: this.connection.namingStrategy.uniqueConstraintName(table, [column.name]),
                    columnNames: [column.name],
                }));
        });
        if (table.uniques.length > 0) {
            const uniquesSql = table.uniques
                .map((unique) => {
                const uniqueName = unique.name
                    ? unique.name
                    : this.connection.namingStrategy.uniqueConstraintName(table, unique.columnNames);
                const columnNames = unique.columnNames
                    .map((columnName) => `"${columnName}"`)
                    .join(", ");
                return `CONSTRAINT "${uniqueName}" UNIQUE (${columnNames})`;
            })
                .join(", ");
            sql += `, ${uniquesSql}`;
        }
        if (table.checks.length > 0) {
            const checksSql = table.checks
                .map((check) => {
                const checkName = check.name
                    ? check.name
                    : this.connection.namingStrategy.checkConstraintName(table, check.expression);
                return `CONSTRAINT "${checkName}" CHECK (${check.expression})`;
            })
                .join(", ");
            sql += `, ${checksSql}`;
        }
        if (table.foreignKeys.length > 0 && createForeignKeys) {
            const foreignKeysSql = table.foreignKeys
                .map((fk) => {
                const columnNames = fk.columnNames
                    .map((columnName) => `"${columnName}"`)
                    .join(", ");
                if (!fk.name)
                    fk.name = this.connection.namingStrategy.foreignKeyName(table, fk.columnNames, this.getTablePath(fk), fk.referencedColumnNames);
                const referencedColumnNames = fk.referencedColumnNames
                    .map((columnName) => `"${columnName}"`)
                    .join(", ");
                let constraint = `CONSTRAINT "${fk.name}" FOREIGN KEY (${columnNames}) REFERENCES ${this.escapePath(this.getTablePath(fk))} (${referencedColumnNames})`;
                if (fk.onDelete && fk.onDelete !== "NO ACTION") {
                    // Oracle does not support NO ACTION, but we set NO ACTION by default in EntityMetadata
                    constraint += ` ON DELETE ${fk.onDelete}`;
                }
                return constraint;
            })
                .join(", ");
            sql += `, ${foreignKeysSql}`;
        }
        const primaryColumns = table.columns.filter((column) => column.isPrimary);
        if (primaryColumns.length > 0) {
            const primaryKeyName = primaryColumns[0].primaryKeyConstraintName
                ? primaryColumns[0].primaryKeyConstraintName
                : this.connection.namingStrategy.primaryKeyName(table, primaryColumns.map((column) => column.name));
            const columnNames = primaryColumns
                .map((column) => `"${column.name}"`)
                .join(", ");
            sql += `, CONSTRAINT "${primaryKeyName}" PRIMARY KEY (${columnNames})`;
        }
        sql += `)`;
        return new Query_1.Query(sql);
    }
    /**
     * Builds drop table sql
     */
    dropTableSql(tableOrName, ifExist) {
        const query = ifExist
            ? `DROP TABLE IF EXISTS ${this.escapePath(tableOrName)}`
            : `DROP TABLE ${this.escapePath(tableOrName)}`;
        return new Query_1.Query(query);
    }
    createViewSql(view) {
        const materializedClause = view.materialized ? "MATERIALIZED " : "";
        if (typeof view.expression === "string") {
            return new Query_1.Query(`CREATE ${materializedClause}VIEW ${this.escapePath(view)} AS ${view.expression}`);
        }
        else {
            return new Query_1.Query(`CREATE ${materializedClause}VIEW ${this.escapePath(view)} AS ${view.expression(this.connection).getQuery()}`);
        }
    }
    insertViewDefinitionSql(view) {
        const expression = typeof view.expression === "string"
            ? view.expression.trim()
            : view.expression(this.connection).getQuery();
        const type = view.materialized
            ? MetadataTableType_1.MetadataTableType.MATERIALIZED_VIEW
            : MetadataTableType_1.MetadataTableType.VIEW;
        const { schema, tableName } = this.driver.parseTableName(view);
        return this.insertTypeormMetadataSql({
            type: type,
            schema: schema,
            name: tableName,
            value: expression,
        });
    }
    /**
     * Builds drop view sql.
     */
    dropViewSql(view) {
        const materializedClause = view.materialized ? "MATERIALIZED " : "";
        return new Query_1.Query(`DROP ${materializedClause}VIEW ${this.escapePath(view)}`);
    }
    /**
     * Builds remove view sql.
     */
    deleteViewDefinitionSql(view) {
        const type = view.materialized
            ? MetadataTableType_1.MetadataTableType.MATERIALIZED_VIEW
            : MetadataTableType_1.MetadataTableType.VIEW;
        const { schema, tableName } = this.driver.parseTableName(view);
        return this.deleteTypeormMetadataSql({
            type: type,
            schema: schema,
            name: tableName,
        });
    }
    /**
     * Builds create index sql.
     */
    createIndexSql(table, index) {
        const columns = index.columnNames
            .map((columnName) => `"${columnName}"`)
            .join(", ");
        return new Query_1.Query(`CREATE ${index.isUnique ? "UNIQUE " : ""}INDEX "${index.name}" ON ${this.escapePath(table)} (${columns})`);
    }
    /**
     * Builds drop index sql.
     */
    dropIndexSql(table, indexOrName) {
        const { schema } = this.driver.parseTableName(table);
        let indexName = InstanceChecker_1.InstanceChecker.isTableIndex(indexOrName)
            ? indexOrName.name
            : indexOrName;
        return schema
            ? new Query_1.Query(`DROP INDEX "${schema}"."${indexName}"`)
            : new Query_1.Query(`DROP INDEX "${indexName}"`);
    }
    /**
     * Builds create primary key sql.
     */
    createPrimaryKeySql(table, columnNames, constraintName) {
        const primaryKeyName = constraintName
            ? constraintName
            : this.connection.namingStrategy.primaryKeyName(table, columnNames);
        const columnNamesString = columnNames
            .map((columnName) => `"${columnName}"`)
            .join(", ");
        return new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${primaryKeyName}" PRIMARY KEY (${columnNamesString})`);
    }
    /**
     * Builds drop primary key sql.
     */
    dropPrimaryKeySql(table) {
        if (!table.primaryColumns.length)
            throw new TypeORMError_1.TypeORMError(`Table ${table} has no primary keys.`);
        const columnNames = table.primaryColumns.map((column) => column.name);
        const constraintName = table.primaryColumns[0].primaryKeyConstraintName;
        const primaryKeyName = constraintName
            ? constraintName
            : this.connection.namingStrategy.primaryKeyName(table, columnNames);
        return new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${primaryKeyName}"`);
    }
    /**
     * Builds create unique constraint sql.
     */
    createUniqueConstraintSql(table, uniqueConstraint) {
        const columnNames = uniqueConstraint.columnNames
            .map((column) => `"` + column + `"`)
            .join(", ");
        return new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${uniqueConstraint.name}" UNIQUE (${columnNames})`);
    }
    /**
     * Builds drop unique constraint sql.
     */
    dropUniqueConstraintSql(table, uniqueOrName) {
        const uniqueName = InstanceChecker_1.InstanceChecker.isTableUnique(uniqueOrName)
            ? uniqueOrName.name
            : uniqueOrName;
        return new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${uniqueName}"`);
    }
    /**
     * Builds create check constraint sql.
     */
    createCheckConstraintSql(table, checkConstraint) {
        return new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${checkConstraint.name}" CHECK (${checkConstraint.expression})`);
    }
    /**
     * Builds drop check constraint sql.
     */
    dropCheckConstraintSql(table, checkOrName) {
        const checkName = InstanceChecker_1.InstanceChecker.isTableCheck(checkOrName)
            ? checkOrName.name
            : checkOrName;
        return new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${checkName}"`);
    }
    /**
     * Builds create foreign key sql.
     */
    createForeignKeySql(table, foreignKey) {
        const columnNames = foreignKey.columnNames
            .map((column) => `"` + column + `"`)
            .join(", ");
        const referencedColumnNames = foreignKey.referencedColumnNames
            .map((column) => `"` + column + `"`)
            .join(",");
        let sql = `ALTER TABLE ${this.escapePath(table)} ADD CONSTRAINT "${foreignKey.name}" FOREIGN KEY (${columnNames}) ` +
            `REFERENCES ${this.escapePath(this.getTablePath(foreignKey))} (${referencedColumnNames})`;
        // Oracle does not support NO ACTION, but we set NO ACTION by default in EntityMetadata
        if (foreignKey.onDelete && foreignKey.onDelete !== "NO ACTION") {
            sql += ` ON DELETE ${foreignKey.onDelete}`;
        }
        return new Query_1.Query(sql);
    }
    /**
     * Builds drop foreign key sql.
     */
    dropForeignKeySql(table, foreignKeyOrName) {
        const foreignKeyName = InstanceChecker_1.InstanceChecker.isTableForeignKey(foreignKeyOrName)
            ? foreignKeyOrName.name
            : foreignKeyOrName;
        return new Query_1.Query(`ALTER TABLE ${this.escapePath(table)} DROP CONSTRAINT "${foreignKeyName}"`);
    }
    /**
     * Escapes a given comment so it's safe to include in a query.
     */
    escapeComment(comment) {
        if (!comment || comment.length === 0) {
            return `''`;
        }
        comment = comment
            .replace(/'/g, "''")
            .replace(/\u0000/g, ""); // Null bytes aren't allowed in comments
        return `'${comment}'`;
    }
    /**
     * Escapes given table or view path.
     */
    escapePath(target) {
        const { schema, tableName } = this.driver.parseTableName(target);
        if (schema && schema !== this.driver.schema) {
            return `"${schema}"."${tableName}"`;
        }
        return `"${tableName}"`;
    }
    /**
     * Builds a part of query to create/change a column.
     */
    buildCreateColumnSql(table, column, skipComment, skipEnum, skipPrimary = true) {
        let c = `"${column.name}" ${this.connection.driver.createFullType(column)}`;
        // if (column.charset) c += ` CHARACTER SET "${column.charset}"`
        // if (column.collation) c += ` COLLATE "${column.collation}"`
        if (column.asExpression)
            c += ` AS (${column.asExpression}) VIRTUAL`;
        if (column.default !== undefined && column.default !== null)
            // DEFAULT must be placed before NOT NULL
            c += ` DEFAULT ${column.default}`;
        if (column.isNullable !== true && !column.isGenerated)
            // NOT NULL is not supported with GENERATED
            c += " NOT NULL";
        if (column.isPrimary && !skipPrimary)
            c += " PRIMARY KEY";
        if (column.isGenerated && column.generationStrategy === "increment")
            c += " IDENTITY(1,1)";
        if (!skipEnum && column.enum) {
            const expression = this.getEnumExpression(column);
            const checkName = this.connection.namingStrategy.checkConstraintName(table, expression, true);
            c += ` CONSTRAINT "${checkName}" CHECK(${expression})`;
        }
        if (!skipComment && column.comment && column.comment.length > 0)
            c += ` COMMENT ${this.escapeComment(column.comment)}`;
        return c;
    }
    getEnumExpression(column) {
        if (!column.enum) {
            return undefined;
        }
        return `"${column.name}" IN (${column.enum.map((val) => "'" + val + "'").join(",")})`;
    }
    isEnumCheckConstraint(name) {
        return name.startsWith("CHK_") && name.endsWith("_ENUM");
    }
}
exports.DmdbQueryRunner = DmdbQueryRunner;
