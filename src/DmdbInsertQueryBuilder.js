"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DmdbInsertQueryBuilder = void 0;
const uuid_1 = require("uuid");
const InsertQueryBuilder_1 = require("typeorm/query-builder/InsertQueryBuilder");
const DriverUtils_1 = require("typeorm/driver/DriverUtils");
const TypeORMError_1 = require("typeorm/error/TypeORMError");
class DmdbInsertQueryBuilder extends InsertQueryBuilder_1.InsertQueryBuilder {
    /**
     * Creates INSERT express used to perform insert query.
     */
    createInsertExpression() {
        // @ylz/typeorm-dm 改动：当 onUpdate 存在且 upsertType 为 merge-into 时，
        // 分流到 DM 专属的 createDmMergeExpression()，生成 MERGE INTO 语句
        // 原版缺少此分支，导致 .orUpdate() 报错 "onUpdate is not supported"
        if (
            this.expressionMap.onUpdate &&
            this.expressionMap.onUpdate.upsertType !== "primary-key" &&
            this.connection.driver.supportedUpsertTypes.includes("merge-into")
        ) {
            return this.createDmMergeExpression();
        }
        const tableName = this.getTableName(this.getMainTableName());
        const valuesExpression = this.createValuesExpression(); // its important to get values before returning expression because oracle rely on native parameters and ordering of them is important
        const returningExpression = this.connection.driver.options.type === "oracle" &&
            this.getValueSets().length > 1
            ? null
            : this.createReturningExpression("insert"); // oracle doesnt support returning with multi-row insert
        const columnsExpression = this.createColumnNamesExpression();
        let query = "INSERT ";
        if (this.expressionMap.onUpdate?.upsertType === "primary-key") {
            query = "UPSERT ";
        }
        if (DriverUtils_1.DriverUtils.isMySQLFamily(this.connection.driver) ||
            this.connection.driver.options.type === "aurora-mysql") {
            query += `${this.expressionMap.onIgnore ? " IGNORE " : ""}`;
        }
        query += `INTO ${tableName}`;
        if (this.alias !== this.getMainTableName() &&
            DriverUtils_1.DriverUtils.isPostgresFamily(this.connection.driver)) {
            query += ` AS "${this.alias}"`;
        }
        // add columns expression
        if (columnsExpression) {
            query += `(${columnsExpression})`;
        }
        else {
            if (!valuesExpression &&
                (DriverUtils_1.DriverUtils.isMySQLFamily(this.connection.driver) ||
                    this.connection.driver.options.type === "aurora-mysql"))
                // special syntax for mysql DEFAULT VALUES insertion
                query += "()";
        }
        // add OUTPUT expression
        if (returningExpression &&
            this.connection.driver.options.type === "mssql") {
            query += ` OUTPUT ${returningExpression}`;
        }
        // add VALUES expression
        if (valuesExpression) {
            if ((this.connection.driver.options.type === "oracle" ||
                this.connection.driver.options.type === "sap") &&
                this.getValueSets().length > 1) {
                query += ` ${valuesExpression}`;
            }
            else {
                query += ` VALUES ${valuesExpression}`;
            }
        }
        else {
            if (DriverUtils_1.DriverUtils.isMySQLFamily(this.connection.driver) ||
                this.connection.driver.options.type === "aurora-mysql") {
                // special syntax for mysql DEFAULT VALUES insertion
                query += " VALUES ()";
            }
            else {
                query += ` DEFAULT VALUES`;
            }
        }
        if (this.expressionMap.onUpdate?.upsertType !== "primary-key") {
            if (this.connection.driver.supportedUpsertTypes.includes("on-conflict-do-update")) {
                if (this.expressionMap.onIgnore) {
                    query += " ON CONFLICT DO NOTHING ";
                }
                else if (this.expressionMap.onConflict) {
                    query += ` ON CONFLICT ${this.expressionMap.onConflict} `;
                }
                else if (this.expressionMap.onUpdate) {
                    const { overwrite, columns, conflict, skipUpdateIfNoValuesChanged, indexPredicate, } = this.expressionMap.onUpdate;
                    let conflictTarget = "ON CONFLICT";
                    if (Array.isArray(conflict)) {
                        conflictTarget += ` ( ${conflict
                            .map((column) => this.escape(column))
                            .join(", ")} )`;
                        if (indexPredicate &&
                            !DriverUtils_1.DriverUtils.isPostgresFamily(this.connection.driver)) {
                            throw new TypeORMError_1.TypeORMError(`indexPredicate option is not supported by the current database driver`);
                        }
                        if (indexPredicate &&
                            DriverUtils_1.DriverUtils.isPostgresFamily(this.connection.driver)) {
                            conflictTarget += ` WHERE ( ${indexPredicate} )`;
                        }
                    }
                    else if (conflict) {
                        conflictTarget += ` ON CONSTRAINT ${this.escape(conflict)}`;
                    }
                    const updatePart = [];
                    if (Array.isArray(overwrite)) {
                        updatePart.push(...overwrite.map((column) => `${this.escape(column)} = EXCLUDED.${this.escape(column)}`));
                    }
                    else if (columns) {
                        updatePart.push(...columns.map((column) => `${this.escape(column)} = :${column}`));
                    }
                    if (updatePart.length > 0) {
                        query += ` ${conflictTarget} DO UPDATE SET `;
                        updatePart.push(...this.expressionMap
                            .mainAlias.metadata.columns.filter((column) => column.isUpdateDate &&
                            !overwrite?.includes(column.databaseName) &&
                            !((this.connection.driver.options
                                .type === "oracle" &&
                                this.getValueSets().length >
                                    1) ||
                                DriverUtils_1.DriverUtils.isSQLiteFamily(this.connection.driver) ||
                                this.connection.driver.options
                                    .type === "sap" ||
                                this.connection.driver.options
                                    .type === "spanner"))
                            .map((column) => `${this.escape(column.databaseName)} = DEFAULT`));
                        query += updatePart.join(", ");
                        query += " ";
                    }
                    if (Array.isArray(overwrite) &&
                        skipUpdateIfNoValuesChanged &&
                        DriverUtils_1.DriverUtils.isPostgresFamily(this.connection.driver)) {
                        query += ` WHERE (`;
                        query += overwrite
                            .map((column) => `${tableName}.${this.escape(column)} IS DISTINCT FROM EXCLUDED.${this.escape(column)}`)
                            .join(" OR ");
                        query += ") ";
                    }
                }
            }
            else if (this.connection.driver.supportedUpsertTypes.includes("on-duplicate-key-update")) {
                if (this.expressionMap.onUpdate) {
                    const { overwrite, columns } = this.expressionMap.onUpdate;
                    if (Array.isArray(overwrite)) {
                        query += " ON DUPLICATE KEY UPDATE ";
                        query += overwrite
                            .map((column) => `${this.escape(column)} = VALUES(${this.escape(column)})`)
                            .join(", ");
                        query += " ";
                    }
                    else if (Array.isArray(columns)) {
                        query += " ON DUPLICATE KEY UPDATE ";
                        query += columns
                            .map((column) => `${this.escape(column)} = :${column}`)
                            .join(", ");
                        query += " ";
                    }
                }
            }
            else {
                if (this.expressionMap.onUpdate) {
                    throw new TypeORMError_1.TypeORMError(`onUpdate is not supported by the current database driver`);
                }
            }
        }
        // add RETURNING expression
        if (returningExpression &&
            (DriverUtils_1.DriverUtils.isPostgresFamily(this.connection.driver) ||
                this.connection.driver.options.type === "oracle" ||
                this.connection.driver.options.type === "cockroachdb" ||
                DriverUtils_1.DriverUtils.isMySQLFamily(this.connection.driver))) {
            query += ` RETURNING ${returningExpression}`;
        }
        // Inserting a specific value for an auto-increment primary key in mssql requires enabling IDENTITY_INSERT
        // IDENTITY_INSERT can only be enabled for tables where there is an IDENTITY column and only if there is a value to be inserted (i.e. supplying DEFAULT is prohibited if IDENTITY_INSERT is enabled)
        if (this.connection.driver.options.type === "mssql" &&
            this.expressionMap.mainAlias.hasMetadata &&
            this.expressionMap
                .mainAlias.metadata.columns.filter((column) => this.expressionMap.insertColumns.length > 0
                ? this.expressionMap.insertColumns.indexOf(column.propertyPath) !== -1
                : column.isInsert)
                .some((column) => this.isOverridingAutoIncrementBehavior(column))) {
            query = `SET IDENTITY_INSERT ${tableName} ON; ${query}; SET IDENTITY_INSERT ${tableName} OFF`;
        }
        // dameng modify: 需要像"mssql"一样，临时允许插入自增列
        if (this.connection.driver.options
            .innerType === "dmdb" &&
            this.expressionMap.mainAlias.hasMetadata &&
            this.expressionMap
                .mainAlias.metadata.columns.filter((column) => this.expressionMap.insertColumns.length > 0
                ? this.expressionMap.insertColumns.indexOf(column.propertyPath) !== -1
                : column.isInsert)
                .some((column) => this.isOverridingAutoIncrementBehavior(column))) {
            query = `SET IDENTITY_INSERT ${tableName} ON WITH REPLACE NULL; ${query}; SET IDENTITY_INSERT ${tableName} OFF`;
        }
        return query;
    }
    /**
     * Creates list of values needs to be inserted in the VALUES expression.
     */
    createValuesExpression() {
        const valueSets = this.getValueSets();
        const columns = this.getInsertedColumns();
        // if column metadatas are given then apply all necessary operations with values
        if (columns.length > 0) {
            let expression = "";
            valueSets.forEach((valueSet, valueSetIndex) => {
                columns.forEach((column, columnIndex) => {
                    if (columnIndex === 0) {
                        if (this.connection.driver.options.type === "oracle" &&
                            valueSets.length > 1) {
                            expression += " SELECT ";
                        }
                        else if (this.connection.driver.options.type === "sap" &&
                            valueSets.length > 1) {
                            expression += " SELECT ";
                        }
                        else {
                            expression += "(";
                        }
                    }
                    // extract real value from the entity
                    let value = column.getEntityValue(valueSet);
                    // if column is relational and value is an object then get real referenced column value from this object
                    // for example column value is { question: { id: 1 } }, value will be equal to { id: 1 }
                    // and we extract "1" from this object
                    /*if (column.referencedColumn && value instanceof Object && !(typeof value === "function")) { // todo: check if we still need it since getEntityValue already has similar code
                        value = column.referencedColumn.getEntityValue(value);
                    }*/
                    if (!(typeof value === "function")) {
                        // make sure our value is normalized by a driver
                        value = this.connection.driver.preparePersistentValue(value, column);
                    }
                    // newly inserted entities always have a version equal to 1 (first version)
                    // also, user-specified version must be empty
                    if (column.isVersion && value === undefined) {
                        expression += "1";
                        // } else if (column.isNestedSetLeft) {
                        //     const tableName = this.connection.driver.escape(column.entityMetadata.tablePath);
                        //     const rightColumnName = this.connection.driver.escape(column.entityMetadata.nestedSetRightColumn!.databaseName);
                        //     const subQuery = `(SELECT c.max + 1 FROM (SELECT MAX(${rightColumnName}) as max from ${tableName}) c)`;
                        //     expression += subQuery;
                        //
                        // } else if (column.isNestedSetRight) {
                        //     const tableName = this.connection.driver.escape(column.entityMetadata.tablePath);
                        //     const rightColumnName = this.connection.driver.escape(column.entityMetadata.nestedSetRightColumn!.databaseName);
                        //     const subQuery = `(SELECT c.max + 2 FROM (SELECT MAX(${rightColumnName}) as max from ${tableName}) c)`;
                        //     expression += subQuery;
                    }
                    else if (column.isDiscriminator) {
                        expression += this.createParameter(this.expressionMap.mainAlias.metadata
                            .discriminatorValue);
                        // return "1";
                        // for create and update dates we insert current date
                        // no, we don't do it because this constant is already in "default" value of the column
                        // with extended timestamp functionality, like CURRENT_TIMESTAMP(6) for example
                        // } else if (column.isCreateDate || column.isUpdateDate) {
                        //     return "CURRENT_TIMESTAMP";
                        // if column is generated uuid and database does not support its generation and custom generated value was not provided by a user - we generate a new uuid value for insertion
                    }
                    else if (column.isGenerated &&
                        column.generationStrategy === "uuid" &&
                        !this.connection.driver.isUUIDGenerationSupported() &&
                        value === undefined) {
                        value = (0, uuid_1.v4)();
                        expression += this.createParameter(value);
                        if (!(valueSetIndex in
                            this.expressionMap.locallyGenerated)) {
                            this.expressionMap.locallyGenerated[valueSetIndex] =
                                {};
                        }
                        column.setEntityValue(this.expressionMap.locallyGenerated[valueSetIndex], value);
                        // if value for this column was not provided then insert default value
                    }
                    else if (value === undefined) {
                        if ((this.connection.driver.options.type === "oracle" &&
                            valueSets.length > 1) ||
                            DriverUtils_1.DriverUtils.isSQLiteFamily(this.connection.driver) ||
                            this.connection.driver.options.type === "sap" ||
                            this.connection.driver.options.type === "spanner" ||
                            // dameng modify:
                            this.connection.driver.options.innerType === "dmdb") {
                            // unfortunately sqlite does not support DEFAULT expression in INSERT queries
                            if (column.default !== undefined &&
                                column.default !== null) {
                                // try to use default defined in the column
                                expression +=
                                    this.connection.driver.normalizeDefault(column);
                            }
                            else {
                                expression += "NULL"; // otherwise simply use NULL and pray if column is nullable
                            }
                        }
                        else {
                            expression += "DEFAULT";
                        }
                    }
                    else if (value === null &&
                        this.connection.driver.options.type === "spanner") {
                        expression += "NULL";
                        // support for SQL expressions in queries
                    }
                    else if (typeof value === "function") {
                        expression += value();
                        // just any other regular value
                    }
                    else {
                        if (this.connection.driver.options.type === "mssql")
                            value = this.connection.driver.parametrizeValue(column, value);
                        // we need to store array values in a special class to make sure parameter replacement will work correctly
                        // if (value instanceof Array)
                        //     value = new ArrayParameter(value);
                        const paramName = this.createParameter(value);
                        if ((DriverUtils_1.DriverUtils.isMySQLFamily(this.connection.driver) ||
                            this.connection.driver.options.type ===
                                "aurora-mysql") &&
                            this.connection.driver.spatialTypes.indexOf(column.type) !== -1) {
                            const useLegacy = this.connection.driver.options.legacySpatialSupport;
                            const geomFromText = useLegacy
                                ? "GeomFromText"
                                : "ST_GeomFromText";
                            if (column.srid != null) {
                                expression += `${geomFromText}(${paramName}, ${column.srid})`;
                            }
                            else {
                                expression += `${geomFromText}(${paramName})`;
                            }
                        }
                        else if (DriverUtils_1.DriverUtils.isPostgresFamily(this.connection.driver) &&
                            this.connection.driver.spatialTypes.indexOf(column.type) !== -1) {
                            if (column.srid != null) {
                                expression += `ST_SetSRID(ST_GeomFromGeoJSON(${paramName}), ${column.srid})::${column.type}`;
                            }
                            else {
                                expression += `ST_GeomFromGeoJSON(${paramName})::${column.type}`;
                            }
                        }
                        else if (this.connection.driver.options.type === "mssql" &&
                            this.connection.driver.spatialTypes.indexOf(column.type) !== -1) {
                            expression +=
                                column.type +
                                    "::STGeomFromText(" +
                                    paramName +
                                    ", " +
                                    (column.srid || "0") +
                                    ")";
                        }
                        else {
                            expression += paramName;
                        }
                    }
                    if (columnIndex === columns.length - 1) {
                        if (valueSetIndex === valueSets.length - 1) {
                            if (this.connection.driver.options.type ===
                                "oracle" &&
                                valueSets.length > 1) {
                                expression += " FROM DUAL ";
                            }
                            else if (this.connection.driver.options.type === "sap" &&
                                valueSets.length > 1) {
                                expression += " FROM dummy ";
                            }
                            else {
                                expression += ")";
                            }
                        }
                        else {
                            if (this.connection.driver.options.type ===
                                "oracle" &&
                                valueSets.length > 1) {
                                expression += " FROM DUAL UNION ALL ";
                            }
                            else if (this.connection.driver.options.type === "sap" &&
                                valueSets.length > 1) {
                                expression += " FROM dummy UNION ALL ";
                            }
                            else {
                                expression += "), ";
                            }
                        }
                    }
                    else {
                        expression += ", ";
                    }
                });
            });
            if (expression === "()")
                return "";
            return expression;
        }
        else {
            // for tables without metadata
            // get values needs to be inserted
            let expression = "";
            valueSets.forEach((valueSet, insertionIndex) => {
                const columns = Object.keys(valueSet);
                columns.forEach((columnName, columnIndex) => {
                    if (columnIndex === 0) {
                        expression += "(";
                    }
                    const value = valueSet[columnName];
                    // support for SQL expressions in queries
                    if (typeof value === "function") {
                        expression += value();
                        // if value for this column was not provided then insert default value
                    }
                    else if (value === undefined) {
                        if ((this.connection.driver.options.type === "oracle" &&
                            valueSets.length > 1) ||
                            DriverUtils_1.DriverUtils.isSQLiteFamily(this.connection.driver) ||
                            this.connection.driver.options.type === "sap" ||
                            this.connection.driver.options.type === "spanner") {
                            expression += "NULL";
                        }
                        else {
                            expression += "DEFAULT";
                        }
                    }
                    else if (value === null &&
                        this.connection.driver.options.type === "spanner") {
                        // just any other regular value
                    }
                    else {
                        expression += this.createParameter(value);
                    }
                    if (columnIndex === Object.keys(valueSet).length - 1) {
                        if (insertionIndex === valueSets.length - 1) {
                            expression += ")";
                        }
                        else {
                            expression += "), ";
                        }
                    }
                    else {
                        expression += ", ";
                    }
                });
            });
            if (expression === "()")
                return "";
            return expression;
        }
    }
    /**
     * Checks if column is an auto-generated primary key, but the current insertion specifies a value for it.
     *
     * @param column
     */
    isOverridingAutoIncrementBehavior(column) {
        return (column.isPrimary &&
            column.isGenerated &&
            column.generationStrategy === "increment" &&
            // dameng modify
            true
        // this.getValueSets().some(
        //     (valueSet) =>
        //         column.getEntityValue(valueSet) !== undefined &&
        //         column.getEntityValue(valueSet) !== null,
        // )
        );
    }
    /**
     * @ylz/typeorm-dm 新增方法：达梦 MERGE INTO upsert 实现
     *
     * 原版 typeorm-dm 不支持 upsert，此方法为完整新增。
     * 生成语法：MERGE INTO "table" USING (SELECT ... FROM DUAL) "s"
     *           ON (...) WHEN MATCHED THEN UPDATE SET ...
     *           WHEN NOT MATCHED THEN INSERT (...) VALUES (...)
     *
     * 达梦 IDENTITY 列特殊处理：
     *   - USING SELECT：非 IDENTITY 列始终包含；IDENTITY 列仅在它是冲突列或用户提供了值时才包含
     *   - INSERT 列/值：排除无用户值的 IDENTITY 列（让 DM 自动生成）
     *   - 如果用户为 IDENTITY 列提供了值：整个语句用 SET IDENTITY_INSERT ON/OFF 包裹
     */
    createDmMergeExpression() {
        const tableName = this.getTableName(this.getMainTableName());
        const tableAlias = this.escape(this.alias);
        const allColumns = this.getInsertedColumns();
        const mergeSourceAlias = this.escape("s");
        const valueSets = this.getValueSets();

        const isIdentityCol = (col) =>
            col.isPrimary && col.isGenerated && col.generationStrategy === "increment";

        const conflictArr = this.expressionMap.onUpdate
            ? (Array.isArray(this.expressionMap.onUpdate.conflict)
                ? this.expressionMap.onUpdate.conflict
                : this.expressionMap.onUpdate.conflict
                    ? [this.expressionMap.onUpdate.conflict]
                    : [])
            : [];

        const identityHasUserValue = (col) =>
            valueSets.some((vs) => {
                const v = col.getEntityValue(vs);
                return v !== undefined && v !== null;
            });

        // USING columns: non-identity always; identity if conflict col or user provides value
        const usingColumns = allColumns.filter((col) => {
            if (!isIdentityCol(col)) return true;
            if (conflictArr.includes(col.databaseName) || conflictArr.includes(col.propertyName)) return true;
            return identityHasUserValue(col);
        });

        // INSERT columns: non-identity always; identity only if user provides value
        const insertColumns = allColumns.filter((col) => {
            if (!isIdentityCol(col)) return true;
            return identityHasUserValue(col);
        });

        const needsIdentityInsert = allColumns.some(
            (col) => isIdentityCol(col) && identityHasUserValue(col)
        );

        // --- USING (SELECT ... FROM DUAL [UNION ALL ...]) s ---
        let usingExpr = "USING (";
        valueSets.forEach((valueSet, vsIdx) => {
            usingExpr += "SELECT ";
            usingColumns.forEach((column, cIdx) => {
                let value = column.getEntityValue(valueSet);
                if (value === undefined) {
                    if (column.default !== undefined && column.default !== null) {
                        usingExpr += this.connection.driver.normalizeDefault(column);
                    } else {
                        usingExpr += "NULL";
                    }
                } else if (value === null) {
                    usingExpr += "NULL";
                } else {
                    if (!(typeof value === "function")) {
                        value = this.connection.driver.preparePersistentValue(value, column);
                    }
                    if (typeof value === "function") {
                        usingExpr += value();
                    } else {
                        usingExpr += this.createParameter(value);
                    }
                }
                usingExpr += ` AS ${this.escape(column.databaseName)}`;
                if (cIdx < usingColumns.length - 1) usingExpr += ", ";
            });
            usingExpr += " FROM DUAL";
            if (vsIdx < valueSets.length - 1) usingExpr += " UNION ALL ";
        });
        usingExpr += `) ${mergeSourceAlias}`;

        let query = `MERGE INTO ${tableName} ${tableAlias} ${usingExpr}`;

        // --- ON (...) ---
        if (this.expressionMap.onUpdate) {
            const { conflict } = this.expressionMap.onUpdate;
            if (Array.isArray(conflict)) {
                query += ` ON (${conflict
                    .map((c) => `${tableAlias}.${this.escape(c)} = ${mergeSourceAlias}.${this.escape(c)}`)
                    .join(" AND ")})`;
            } else if (conflict) {
                query += ` ON (${tableAlias}.${this.escape(conflict)} = ${mergeSourceAlias}.${this.escape(conflict)})`;
            }
        }

        // --- WHEN MATCHED THEN UPDATE SET ... ---
        if (this.expressionMap.onUpdate) {
            const { overwrite, conflict } = this.expressionMap.onUpdate;
            if (Array.isArray(overwrite)) {
                const updateCols = overwrite.filter(
                    (c) => !(Array.isArray(conflict) && conflict.includes(c))
                );
                if (updateCols.length > 0) {
                    query += ` WHEN MATCHED THEN UPDATE SET ${updateCols
                        .map((c) => `${tableAlias}.${this.escape(c)} = ${mergeSourceAlias}.${this.escape(c)}`)
                        .join(", ")}`;
                }
            }
        }

        // --- WHEN NOT MATCHED THEN INSERT (...) VALUES (...) ---
        const insertColNames = insertColumns
            .map((c) => this.escape(c.databaseName))
            .join(", ");
        const insertColValues = insertColumns
            .map((c) => `${mergeSourceAlias}.${this.escape(c.databaseName)}`)
            .join(", ");

        query += ` WHEN NOT MATCHED THEN INSERT (${insertColNames}) VALUES (${insertColValues})`;

        if (needsIdentityInsert) {
            query = `SET IDENTITY_INSERT ${tableName} ON WITH REPLACE NULL; ${query}; SET IDENTITY_INSERT ${tableName} OFF`;
        }

        return query;
    }
}
exports.DmdbInsertQueryBuilder = DmdbInsertQueryBuilder;
