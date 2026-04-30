"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DmdbDriver = void 0;
const DriverUtils_1 = require("typeorm/driver/DriverUtils");
const DriverPackageNotInstalledError_1 = require("typeorm/error/DriverPackageNotInstalledError");
const ConnectionIsNotSetError_1 = require("typeorm/error/ConnectionIsNotSetError");
const TypeORMError_1 = require("typeorm/error/TypeORMError");
const RdbmsSchemaBuilder_1 = require("typeorm/schema-builder/RdbmsSchemaBuilder");
const DmdbQueryRunner_1 = require("./DmdbQueryRunner");
const InstanceChecker_1 = require("typeorm/util/InstanceChecker");
const ApplyValueTransformers_1 = require("typeorm/util/ApplyValueTransformers");
const DateUtils_1 = require("typeorm/util/DateUtils");
const OrmUtils_1 = require("typeorm/util/OrmUtils");
// 通过搜索 dameng modify ，查看达梦改写的代码
/**
 * Organizes communication with Dameng DB.
 */
class DmdbDriver {
    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------
    constructor(connection) {
        /**
         * Pool for slave databases.
         * Used in replication.
         */
        this.slaves = [];
        /**
         * Indicates if replication is enabled.
         */
        this.isReplicated = false;
        /**
         * Indicates if tree tables are supported by this driver.
         */
        this.treeSupport = true;
        /**
         * Represent transaction support by this driver
         */
        this.transactionSupport = "nested";
        /**
         * Gets list of supported column data types by a driver.
         */
        this.supportedDataTypes = [
            // numeric types
            "bit",
            "int",
            "tinyint",
            "smallint",
            "bigint",
            "float",
            "double",
            "real", // synonym for double
            "decimal",
            "dec", // synonym for decimal
            "number", // synonym for decimal
            "numeric", // synonym for decimal
            // date and time types
            "date",
            "datetime",
            "timestamp",
            "timestamp with time zone",
            "timestamp with local time zone",
            "time",
            "interval year to month",
            "interval day to second",
            // string types
            "char",
            "varchar",
            "blob",
            "clob",
            "text", // synonym for clob
            "binary",
            "varbinary",
            "image",
        ];
        /**
         * Returns type of upsert supported by driver if any
         *
         * @ylz/typeorm-dm 改动：原版为 []，改为 ["merge-into"] 以启用 MERGE INTO upsert
         */
        this.supportedUpsertTypes = ["merge-into"];
        /**
         * Returns list of supported onDelete types by driver.
         */
        this.supportedOnDeleteTypes = [
            "CASCADE",
            "SET NULL",
            "NO ACTION",
        ];
        /**
         * Returns list of supported onUpdate types by driver.
         */
        this.supportedOnUpdateTypes = ["NO ACTION"];
        /**
         * Gets list of spatial column data types.
         */
        this.spatialTypes = [];
        /**
         * Gets list of column data types that support length by a driver.
         */
        this.withLengthColumnTypes = [
            "char",
            "varchar",
            "binary",
            "varbinary",
            "raw"
        ];
        /**
         * Gets list of column data types that support length by a driver.
         */
        this.withWidthColumnTypes = [];
        /**
         * Gets list of column data types that support precision by a driver.
         */
        this.withPrecisionColumnTypes = [
            "float",
            "decimal",
            "dec",
            "number",
            "numeric",
            "time",
            "datetime",
            "timestamp",
            "timestamp with time zone",
            "timestamp with local time zone",
        ];
        /**
         * Gets list of column data types that supports scale by a driver.
         */
        this.withScaleColumnTypes = [
            "float",
            "double",
            "real",
            "decimal",
            "dec",
            "number",
            "numeric",
        ];
        /**
         * Gets list of column data types that supports UNSIGNED and ZEROFILL attributes.
         */
        this.unsignedAndZerofillTypes = [];
        /**
         * ORM has special columns and we need to know what database column types should be for those columns.
         * Column types are driver dependant.
         */
        this.mappedDataTypes = {
            createDate: "timestamp",
            createDatePrecision: 6,
            createDateDefault: "CURRENT_TIMESTAMP(6)",
            updateDate: "timestamp",
            updateDatePrecision: 6,
            updateDateDefault: "CURRENT_TIMESTAMP(6)",
            deleteDate: "timestamp",
            deleteDatePrecision: 6,
            deleteDateNullable: true,
            version: "int",
            treeLevel: "int",
            migrationId: "int",
            migrationName: "varchar",
            migrationTimestamp: "bigint",
            cacheId: "int",
            cacheIdentifier: "varchar",
            cacheTime: "bigint",
            cacheDuration: "int",
            cacheQuery: "text",
            cacheResult: "text",
            metadataType: "varchar",
            metadataDatabase: "varchar",
            metadataSchema: "varchar",
            metadataTable: "varchar",
            metadataName: "varchar",
            metadataValue: "text",
        };
        /**
         * The prefix used for the parameters
         * // TODO maybe no need?
         */
        // parametersPrefix = ":"
        /**
         * Default values of length, precision and scale depends on column data type.
         * Used in the cases when length/precision/scale is not specified by user.
         */
        this.dataTypeDefaults = {
            varchar: { length: 255 },
            char: { length: 1 },
            binary: { length: 1 },
            varbinary: { length: 255 },
            decimal: { precision: 10, scale: 0 },
            dec: { precision: 10, scale: 0 },
            number: { precision: 10, scale: 0 },
            numeric: { precision: 10, scale: 0 },
            float: { precision: 53 },
            double: { precision: 53 },
            time: { precision: 0 },
            datetime: { precision: 6 },
            timestamp: { precision: 6 },
            "timestamp with time zone": { precision: 6 },
            "timestamp with local time zone": { precision: 6 },
        };
        /**
         * Max length allowed by Dmdb for aliases.
         */
        this.maxAliasLength = 63;
        this.cteCapabilities = {
            enabled: true,
            requiresRecursiveHint: true,
        };
        this.dummyTableName = "DUAL";
        /**
         * Supported returning types
         */
        this._isReturningSqlSupported = {
            delete: true,
            insert: true,
            update: true,
        };
        this.connection = connection;
        this.options = connection.options;
        // load dmdb package
        this.loadDependencies();
        // this.database = DriverUtils.buildDriverOptions(
        //     this.options.replication
        //         ? this.options.replication.master
        //         : this.options,
        // ).database
        this.schema = DriverUtils_1.DriverUtils.buildDriverOptions(this.options).schema;
        // validate options to make sure everything is set
        // todo: revisit validation with replication in mind
        // if (!(this.options.host || (this.options.extra && this.options.extra.socketPath)) && !this.options.socketPath)
        //     throw new DriverOptionNotSetError("socketPath and host");
        // if (!this.options.username)
        //     throw new DriverOptionNotSetError("username");
        // if (!this.options.database)
        //     throw new DriverOptionNotSetError("database");
        // todo: check what is going on when connection is setup without database and how to connect to a database then?
        // todo: provide options to auto-create a database if it does not exist yet
    }
    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------
    /**
     * Performs connection to the database.
     */
    async connect() {
        this.dmdb.fetchAsString = [this.dmdb.CLOB];
        this.dmdb.fetchAsBuffer = [this.dmdb.BLOB];
        this.dmdb.outBindFormat = this.dmdb.OUT_FORMAT_ARRAY;
        if (this.options.replication) {
            this.slaves = await Promise.all(this.options.replication.slaves.map((slave) => {
                return this.createPool(this.options, slave);
            }));
            this.master = await this.createPool(this.options, this.options.replication.master);
        }
        else {
            this.master = await this.createPool(this.options, this.options);
        }
        // if (!this.schema) {
        const queryRunner = await this.createQueryRunner("master");
        this.schema = await queryRunner.getCurrentSchema();
        Object.assign(this.options, { schema: this.schema });
        await queryRunner.release();
        // }
    }
    /**
     * Makes any action after connection (e.g. create extensions in Postgres driver).
     */
    afterConnect() {
        return Promise.resolve();
    }
    /**
     * Closes connection with the database.
     */
    async disconnect() {
        if (!this.master)
            return Promise.reject(new ConnectionIsNotSetError_1.ConnectionIsNotSetError("dmdb"));
        await this.closePool(this.master);
        await Promise.all(this.slaves.map((slave) => this.closePool(slave)));
        this.master = undefined;
        this.slaves = [];
    }
    /**
     * Creates a schema builder used to build and sync a schema.
     */
    createSchemaBuilder() {
        return new RdbmsSchemaBuilder_1.RdbmsSchemaBuilder(this.connection);
    }
    /**
     * Creates a query runner used to execute database queries.
     */
    createQueryRunner(mode) {
        return new DmdbQueryRunner_1.DmdbQueryRunner(this, mode);
    }
    /**
     * Replaces parameters in the given sql with special escaping character
     * and an array of parameter names to be passed to a query.
     */
    escapeQueryWithParameters(sql, parameters, nativeParameters) {
        const escapedParameters = Object.keys(nativeParameters).map((key) => {
            if (typeof nativeParameters[key] === "boolean")
                return nativeParameters[key] ? 1 : 0;
            return nativeParameters[key];
        });
        if (!parameters || !Object.keys(parameters).length)
            return [sql, escapedParameters];
        sql = sql.replace(/:(\.\.\.)?([A-Za-z0-9_.]+)/g, (full, isArray, key) => {
            if (!parameters.hasOwnProperty(key)) {
                return full;
            }
            let value = parameters[key];
            if (isArray) {
                return value
                    .map((v) => {
                    escapedParameters.push(v);
                    return this.createParameter(key, escapedParameters.length - 1);
                })
                    .join(", ");
            }
            if (typeof value === "function") {
                return value();
            }
            if (typeof value === "boolean") {
                return value ? "1" : "0";
            }
            escapedParameters.push(value);
            return this.createParameter(key, escapedParameters.length - 1);
        }); // todo: make replace only in value statements, otherwise problems
        return [sql, escapedParameters];
    }
    /**
     * Escapes a column name.
     */
    escape(columnName) {
        return `"${columnName}"`;
    }
    /**
     * Build full table name with database name, schema name and table name.
     * Dameng does not support databases.
     * E.g. mySchema.myTable
     */
    buildTableName(tableName, schema, database) {
        let tablePath = [tableName];
        if (schema) {
            tablePath.unshift(schema);
        }
        return tablePath.join(".");
    }
    /**
     * Parse a target table name or other types and return a normalized table definition.
     */
    parseTableName(target) {
        const driverDatabase = undefined;
        const driverSchema = this.schema;
        if (InstanceChecker_1.InstanceChecker.isTable(target) || InstanceChecker_1.InstanceChecker.isView(target)) {
            const parsed = this.parseTableName(target.name);
            return {
                database: target.database || parsed.database || driverDatabase,
                schema: target.schema || parsed.schema || driverSchema,
                tableName: parsed.tableName,
            };
        }
        if (InstanceChecker_1.InstanceChecker.isTableForeignKey(target)) {
            const parsed = this.parseTableName(target.referencedTableName);
            return {
                database: target.referencedDatabase ||
                    parsed.database ||
                    driverDatabase,
                schema: target.referencedSchema || parsed.schema || driverSchema,
                tableName: parsed.tableName,
            };
        }
        if (InstanceChecker_1.InstanceChecker.isEntityMetadata(target)) {
            // EntityMetadata tableName is never a path
            return {
                database: target.database || driverDatabase,
                schema: target.schema || driverSchema,
                tableName: target.tableName,
            };
        }
        const parts = target.split(".");
        return {
            database: driverDatabase,
            schema: (parts.length > 1 ? parts[0] : undefined) || driverSchema,
            tableName: parts.length > 1 ? parts[1] : parts[0],
        };
    }
    /**
     * Prepares given value to a value to be persisted, based on its column type and metadata.
     */
    preparePersistentValue(value, columnMetadata) {
        if (columnMetadata.transformer)
            value = ApplyValueTransformers_1.ApplyValueTransformers.transformTo(columnMetadata.transformer, value);
        if (value === null || value === undefined)
            return value;
        if (columnMetadata.type === Boolean) {
            return value ? 1 : 0;
        }
        else if (columnMetadata.type === "date") {
            if (typeof value === "string")
                value = value.replace(/[^0-9-]/g, "");
            return () => `TO_DATE('${DateUtils_1.DateUtils.mixedDateToDateString(value)}', 'YYYY-MM-DD')`;
        }
        else if (columnMetadata.type === "time") {
            return DateUtils_1.DateUtils.mixedDateToTimeString(value);
        }
        else if (columnMetadata.type === "json") {
            return JSON.stringify(value);
        }
        else if (columnMetadata.type === "timestamp" ||
            columnMetadata.type === "timestamp with time zone" ||
            columnMetadata.type === "timestamp with local time zone" ||
            columnMetadata.type === "datetime" ||
            columnMetadata.type === Date) {
            return DateUtils_1.DateUtils.mixedDateToDate(value);
        }
        else if (columnMetadata.type === "simple-array") {
            return DateUtils_1.DateUtils.simpleArrayToString(value);
        }
        else if (columnMetadata.type === "simple-json") {
            return DateUtils_1.DateUtils.simpleJsonToString(value);
        }
        else if (columnMetadata.type === "simple-enum") {
            return DateUtils_1.DateUtils.simpleEnumToString(value);
        }
        return value;
    }
    /**
     * Prepares given value to a value to be persisted, based on its column type or metadata.
     */
    prepareHydratedValue(value, columnMetadata) {
        if (value === null || value === undefined)
            return columnMetadata.transformer
                ? ApplyValueTransformers_1.ApplyValueTransformers.transformFrom(columnMetadata.transformer, value)
                : value;
        if (columnMetadata.type === Boolean ||
            columnMetadata.type === "bool" ||
            columnMetadata.type === "boolean") {
            value = value ? true : false;
        }
        else if (columnMetadata.type === "datetime" ||
            columnMetadata.type === Date) {
            value = DateUtils_1.DateUtils.normalizeHydratedDate(value);
        }
        else if (columnMetadata.type === "date") {
            value = DateUtils_1.DateUtils.mixedDateToDateString(value);
        }
        else if (columnMetadata.type === "json") {
            value = typeof value === "string" ? JSON.parse(value) : value;
        }
        else if (columnMetadata.type === "time") {
            value = DateUtils_1.DateUtils.mixedTimeToString(value);
        }
        else if (columnMetadata.type === "simple-array") {
            value = DateUtils_1.DateUtils.stringToSimpleArray(value);
        }
        else if (columnMetadata.type === "simple-json") {
            value = DateUtils_1.DateUtils.stringToSimpleJson(value);
        }
        else if ((columnMetadata.type === "enum" ||
            columnMetadata.type === "simple-enum")) {
            // convert to number if that exists in possible enum options
            value = DateUtils_1.DateUtils.stringToSimpleEnum(value, columnMetadata);
        }
        else if (columnMetadata.type === "set") {
            value = DateUtils_1.DateUtils.stringToSimpleArray(value);
        }
        else if (columnMetadata.type === Number) {
            // convert to number if number
            value = !isNaN(+value) ? parseInt(value) : value;
        }
        if (columnMetadata.transformer)
            value = ApplyValueTransformers_1.ApplyValueTransformers.transformFrom(columnMetadata.transformer, value);
        return value;
    }
    /**
     * Creates a database type from a given column metadata.
     */
    normalizeType(column) {
        if (column.type === "integer") {
            return "int";
        }
        else if (column.type === Boolean ||
            column.type === "boolean" ||
            column.type === "bool") {
            return "bit";
        }
        else if (column.type === Number) {
            return "number";
        }
        else if (column.type === "double precision") {
            return "double";
        }
        else if (column.type === "nchar" ||
            column.type === "character") {
            return "char";
        }
        else if (column.type === "varchar2" ||
            column.type === "nvarchar" ||
            column.type === "nvarchar2") {
            return "varchar";
        }
        else if (column.type === "raw") {
            return "varbinary";
        }
        else if (column.type === String) {
            return "varchar";
        }
        else if (column.type === Date) {
            return "timestamp";
        }
        else if (column.type === Buffer) {
            return "blob";
        }
        else if (column.type === "long" ||
            column.type === "nclob") {
            return "clob";
        }
        else if (column.type === "uuid") {
            return "varchar";
        }
        else if (column.type === "enum" ||
            column.type === "simple-enum") {
            return "varchar";
        }
        else if (column.type === "json" ||
            column.type === "simple-array" ||
            column.type === "simple-json") {
            return "clob";
        }
        else {
            return column.type || "";
        }
    }
    /**
     * Normalizes "default" value of the column.
     */
    normalizeDefault(columnMetadata) {
        const defaultValue = columnMetadata.default;
        if (typeof defaultValue === "number") {
            return "" + defaultValue;
        }
        if (typeof defaultValue === "boolean") {
            return defaultValue ? "1" : "0";
        }
        if (typeof defaultValue === "function") {
            return defaultValue();
        }
        if (typeof defaultValue === "string") {
            return `'${defaultValue}'`;
        }
        if (defaultValue === null || defaultValue === undefined) {
            return undefined;
        }
        return `${defaultValue}`;
    }
    /**
     * Normalizes "isUnique" value of the column.
     */
    normalizeIsUnique(column) {
        return column.entityMetadata.uniques.some((uq) => uq.columns.length === 1 && uq.columns[0] === column);
    }
    /**
     * Returns default column lengths, which is required on column creation.
     */
    getColumnLength(column) {
        if (column.length)
            return column.length.toString();
        switch (column.type) {
            case String:
            case "varchar":
            case "varchar2":
            case "nvarchar":
            case "nvarchar2":
                return "255";
            case "varbinary":
                return "255";
            case "uuid":
                return "36";
            default:
                return "";
        }
    }
    /**
     * Creates column type definition including length, precision and scale
     */
    createFullType(column) {
        let type = column.type;
        // used 'getColumnLength()' method, because Dameng requires column length for some data types
        if (this.getColumnLength(column)) {
            type += `(${this.getColumnLength(column)})`;
        }
        else if (column.precision !== null &&
            column.precision !== undefined &&
            column.scale !== null &&
            column.scale !== undefined) {
            type += `(${column.precision},${column.scale})`;
        }
        else if (column.precision !== null &&
            column.precision !== undefined) {
            type += `(${column.precision})`;
        }
        if (column.type === "timestamp with time zone") {
            type =
                "TIMESTAMP" +
                    (column.precision !== null && column.precision !== undefined
                        ? "(" + column.precision + ")"
                        : "") +
                    " WITH TIME ZONE";
        }
        else if (column.type === "timestamp with local time zone") {
            type =
                "TIMESTAMP" +
                    (column.precision !== null && column.precision !== undefined
                        ? "(" + column.precision + ")"
                        : "") +
                    " WITH LOCAL TIME ZONE";
        }
        if (column.isArray)
            type += " array";
        return type;
    }
    /**
     * Obtains a new database connection to a master server.
     * Used for replication.
     * If replication is not setup then returns default connection's database connection.
     */
    obtainMasterConnection() {
        return new Promise((ok, fail) => {
            if (!this.master) {
                return fail(new TypeORMError_1.TypeORMError("Driver not Connected"));
            }
            this.master.getConnection((err, connection, release) => {
                if (err)
                    return fail(err);
                ok(connection);
            });
        });
    }
    /**
     * Obtains a new database connection to a slave server.
     * Used for replication.
     * If replication is not setup then returns master (default) connection's database connection.
     */
    obtainSlaveConnection() {
        if (!this.slaves.length)
            return this.obtainMasterConnection();
        return new Promise((ok, fail) => {
            const random = Math.floor(Math.random() * this.slaves.length);
            this.slaves[random].getConnection((err, connection) => {
                if (err)
                    return fail(err);
                ok(connection);
            });
        });
    }
    /**
     * Creates generated map of values generated or returned by database after INSERT query.
     */
    createGeneratedMap(metadata, insertResult, entityIndex) {
        if (!insertResult) {
            return undefined;
        }
        // if (insertResult.insertId === undefined) {
        return Object.keys(insertResult).reduce((map, key) => {
            const column = metadata.findColumnWithDatabaseName(key);
            if (column) {
                OrmUtils_1.OrmUtils.mergeDeep(map, column.createValueMap(this.prepareHydratedValue(insertResult[key], column)));
            }
            return map;
        }, {});
        // }
        // const generatedMap = metadata.generatedColumns.reduce(
        //     (map, generatedColumn) => {
        //         let value: any
        //         if (
        //             generatedColumn.generationStrategy === "increment" &&
        //             insertResult.insertId
        //         ) {
        //             // NOTE: When multiple rows is inserted by a single INSERT statement,
        //             // `insertId` is the value generated for the first inserted row only.
        //             value = insertResult.insertId + entityIndex
        //             // } else if (generatedColumn.generationStrategy === "uuid") {
        //             //     console.log("getting db value:", generatedColumn.databaseName);
        //             //     value = generatedColumn.getEntityValue(uuidMap);
        //         }
        //         return OrmUtils.mergeDeep(
        //             map,
        //             generatedColumn.createValueMap(value),
        //         )
        //     },
        //     {} as ObjectLiteral,
        // )
        // return Object.keys(generatedMap).length > 0 ? generatedMap : undefined
    }
    /**
     * Differentiate columns of this table and columns from the given column metadatas columns
     * and returns only changed.
     */
    findChangedColumns(tableColumns, columnMetadatas) {
        return columnMetadatas.filter((columnMetadata) => {
            const tableColumn = tableColumns.find((c) => c.name === columnMetadata.databaseName);
            if (!tableColumn)
                return false; // we don't need new columns, we only need exist and changed
            const isColumnChanged = tableColumn.name !== columnMetadata.databaseName ||
                this.isColumnDataTypeChanged(tableColumn, columnMetadata) ||
                tableColumn.length !== this.getColumnLength(columnMetadata) ||
                (columnMetadata.precision !== undefined &&
                    tableColumn.precision !== columnMetadata.precision) ||
                (columnMetadata.scale !== undefined &&
                    tableColumn.scale !== columnMetadata.scale) ||
                // tableColumn.zerofill !== columnMetadata.zerofill ||
                // tableColumn.unsigned !== columnMetadata.unsigned ||
                tableColumn.asExpression !== columnMetadata.asExpression ||
                tableColumn.generatedType !== columnMetadata.generatedType ||
                tableColumn.comment !==
                    this.escapeComment(columnMetadata.comment) ||
                !this.compareDefaultValues(this.normalizeDefault(columnMetadata), tableColumn.default) ||
                (tableColumn.enum &&
                    columnMetadata.enum &&
                    !OrmUtils_1.OrmUtils.isArraysEqual(tableColumn.enum, columnMetadata.enum.map((val) => val + ""))) ||
                // tableColumn.onUpdate !==
                //     this.normalizeDatetimeFunction(columnMetadata.onUpdate) ||
                tableColumn.isPrimary !== columnMetadata.isPrimary ||
                !this.compareNullableValues(columnMetadata, tableColumn) ||
                tableColumn.isUnique !==
                    this.normalizeIsUnique(columnMetadata) ||
                (columnMetadata.generationStrategy !== "uuid" &&
                    tableColumn.isGenerated !== columnMetadata.isGenerated);
            // DEBUG SECTION
            // if (isColumnChanged) {
            //     console.log("table:", columnMetadata.entityMetadata.tableName)
            //     console.log(
            //         "name:",
            //         tableColumn.name,
            //         columnMetadata.databaseName,
            //     )
            //     console.log(
            //         "type:",
            //         tableColumn.type,
            //         this.normalizeType(columnMetadata),
            //     )
            //     console.log(
            //         "length:",
            //         tableColumn.length,
            //         columnMetadata.length,
            //     )
            //     console.log("width:", tableColumn.width, columnMetadata.width)
            //     console.log(
            //         "precision:",
            //         tableColumn.precision,
            //         columnMetadata.precision,
            //     )
            //     console.log("scale:", tableColumn.scale, columnMetadata.scale)
            //     console.log(
            //         "zerofill:",
            //         tableColumn.zerofill,
            //         columnMetadata.zerofill,
            //     )
            //     console.log(
            //         "unsigned:",
            //         tableColumn.unsigned,
            //         columnMetadata.unsigned,
            //     )
            //     console.log(
            //         "asExpression:",
            //         tableColumn.asExpression,
            //         columnMetadata.asExpression,
            //     )
            //     console.log(
            //         "generatedType:",
            //         tableColumn.generatedType,
            //         columnMetadata.generatedType,
            //     )
            //     console.log(
            //         "comment:",
            //         tableColumn.comment,
            //         this.escapeComment(columnMetadata.comment),
            //     )
            //     console.log(
            //         "default:",
            //         tableColumn.default,
            //         this.normalizeDefault(columnMetadata),
            //     )
            //     console.log("enum:", tableColumn.enum, columnMetadata.enum)
            //     console.log(
            //         "default changed:",
            //         !this.compareDefaultValues(
            //             this.normalizeDefault(columnMetadata),
            //             tableColumn.default,
            //         ),
            //     )
            //     console.log(
            //         "isPrimary:",
            //         tableColumn.isPrimary,
            //         columnMetadata.isPrimary,
            //     )
            //     console.log(
            //         "isNullable changed:",
            //         !this.compareNullableValues(columnMetadata, tableColumn),
            //     )
            //     console.log(
            //         "isUnique:",
            //         tableColumn.isUnique,
            //         this.normalizeIsUnique(columnMetadata),
            //     )
            //     console.log(
            //         "isGenerated:",
            //         tableColumn.isGenerated,
            //         columnMetadata.isGenerated,
            //     )
            //     console.log(
            //         columnMetadata.generationStrategy !== "uuid" &&
            //             tableColumn.isGenerated !== columnMetadata.isGenerated,
            //     )
            //     console.log("==========================================")
            // }
            return isColumnChanged;
        });
    }
    /**
     * Returns true if driver supports RETURNING / OUTPUT statement.
     */
    isReturningSqlSupported(returningType) {
        return this._isReturningSqlSupported[returningType];
    }
    /**
     * Returns true if driver supports uuid values generation on its own.
     */
    isUUIDGenerationSupported() {
        return false;
    }
    /**
     * Returns true if driver supports fulltext indices.
     */
    isFullTextColumnTypeSupported() {
        // TODO 暂不支持全文索引
        return false;
    }
    /**
     * Creates an escaped parameter.
     */
    createParameter(parameterName, index) {
        return "?";
    }
    /**
     * Converts column type in to native dmdb type.
     * TODO 借了oracle的壳，QueryBuilder.ts:952
     */
    columnTypeToNativeParameter(type) {
        switch (this.normalizeType({ type: type })) {
            case "number":
            case "numeric":
            case "int":
            case "integer":
            case "smallint":
            case "dec":
            case "decimal":
                return this.dmdb.NUMBER;
            case "char":
            case "nchar":
            case "varchar2":
            case "nvarchar2":
                return this.dmdb.STRING;
            case "blob":
                return this.dmdb.BLOB;
            case "simple-json":
            case "json":
            case "clob":
                return this.dmdb.CLOB;
            case "date":
            case "timestamp":
            case "timestamp with time zone":
            case "timestamp with local time zone":
                return this.dmdb.DATE;
        }
    }
    // -------------------------------------------------------------------------
    // Protected Methods
    // -------------------------------------------------------------------------
    /**
     * Loads all driver dependencies.
     */
    loadDependencies() {
        try {
            const dmdb = this.options.driver || require("dmdb");
            this.dmdb = dmdb;
            this.oracle = dmdb;
        }
        catch (e) {
            throw new DriverPackageNotInstalledError_1.DriverPackageNotInstalledError("Dmdb", "dmdb");
        }
    }
    /**
     * Creates a new connection pool for a given database credentials.
     */
    createPool(options, credentials) {
        credentials = Object.assign({}, credentials, DriverUtils_1.DriverUtils.buildDriverOptions(credentials)); // todo: do it better way
        if (!credentials.url) {
            let url = "dm://";
            url += credentials.username || "SYSDBA";
            url += ":";
            url += credentials.password || "SYSDBA";
            url += "@";
            url += credentials.host || "localhost";
            url += ":";
            url += credentials.port || 5236;
            if (credentials.schema) {
                url += "?schema=" + credentials.schema;
            }
            Object.assign(credentials, { url });
        }
        // build connection options for the driver
        const connectionOptions = Object.assign({}, {
            connectString: credentials.url,
        }, {
            poolMax: options.poolSize,
        }, options.extra || {});
        return new Promise((ok, fail) => {
            this.dmdb.createPool(connectionOptions, (err, pool) => {
                if (err)
                    return fail(err);
                ok(pool);
            });
        });
    }
    /**
     * Closes connection pool.
     */
    async closePool(pool) {
        return new Promise((ok, fail) => {
            pool.close((err) => (err ? fail(err) : ok()));
            pool = undefined;
        });
    }
    /**
     * Checks if "DEFAULT" values in the column metadata and in the database are equal.
     */
    compareDefaultValues(columnMetadataValue, databaseValue) {
        if (typeof columnMetadataValue === "string" &&
            typeof databaseValue === "string") {
            // we need to cut out "'" because in mysql we can understand returned value is a string or a function
            // as result compare cannot understand if default is really changed or not
            columnMetadataValue = columnMetadataValue.replace(/^'+|'+$/g, "");
            databaseValue = databaseValue.replace(/^'+|'+$/g, "");
        }
        return columnMetadataValue === databaseValue;
    }
    compareNullableValues(columnMetadata, tableColumn) {
        return columnMetadata.isNullable === tableColumn.isNullable;
    }
    /**
     * If parameter is a datetime function, e.g. "CURRENT_TIMESTAMP", normalizes it.
     * Otherwise returns original input.
     */
    normalizeDatetimeFunction(value) {
        if (!value)
            return value;
        // check if input is datetime function
        const isDatetimeFunction = value.toUpperCase().indexOf("CURRENT_TIMESTAMP") !== -1 ||
            value.toUpperCase().indexOf("NOW") !== -1;
        if (isDatetimeFunction) {
            // extract precision, e.g. "(3)"
            const precision = value.match(/\(\d+\)/);
            return precision
                ? `CURRENT_TIMESTAMP${precision[0]}`
                : "CURRENT_TIMESTAMP";
        }
        else {
            return value;
        }
    }
    /**
     * Escapes a given comment.
     */
    escapeComment(comment) {
        if (!comment)
            return comment;
        comment = comment.replace(/\u0000/g, ""); // Null bytes aren't allowed in comments
        return comment;
    }
    /**
     * A helper to check if column data types have changed
     * This can be used to manage checking any types the
     * database may alias
     */
    isColumnDataTypeChanged(tableColumn, columnMetadata) {
        // this is an exception for mariadb versions where json is an alias for longtext
        if (this.normalizeType(columnMetadata) === "json" &&
            tableColumn.type.toLowerCase() === "longtext")
            return false;
        return tableColumn.type !== this.normalizeType(columnMetadata);
    }
}
exports.DmdbDriver = DmdbDriver;
