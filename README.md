# @ylz-api/typeorm-dm

> Fork 自 [typeorm-dm@1.0.43524](https://www.npmjs.com/package/typeorm-dm)，针对 TypeORM 0.3.25+ 补充了原版缺失的功能。

达梦数据库驱动 [dmdb](https://www.npmjs.com/package/dmdb) 适配 [TypeORM](https://www.npmjs.com/package/typeorm) 框架的方言包。

## 与原版的区别

### 1. MERGE INTO upsert（`.orUpdate()`）

原版缺少 TypeORM 0.3.25+ 的 `merge-into` upsert 路径，导致 `.orUpdate()` 报错：
`"onUpdate is not supported by the current database driver"`

**改动：**
- `DmdbDriver.js` — `supportedUpsertTypes` 改为 `["merge-into"]`
- `createInsertExpression()` 增加分流，当 `onUpdate` 存在且为 merge-into 类型时，走 `createDmMergeExpression()`
- 新增 `createDmMergeExpression()` — 生成达梦兼容的 `MERGE INTO` 语句，正确处理 IDENTITY（自增）列的自动排除和 `SET IDENTITY_INSERT ON/OFF`

### 2. orIgnore 兼容（`.orIgnore()`）

达梦不支持 `INSERT IGNORE INTO`，调用 `.orIgnore()` 会报 `[-6602] 违反唯一性约束`。

**改动：**
- `createInsertExpression()` 检测到 `onIgnore` 时，分流到 `createDmMergeExpressionForIgnore()`
- 新增 `createDmMergeExpressionForIgnore()` — 生成不含 `WHEN MATCHED` 子句的 `MERGE INTO`，命中冲突时跳过，未命中时正常插入

**ON 条件推断优先级：**
1. 所有 `@Unique` 约束（OR 连接，组内列 AND 连接）
2. 所有 `@Index({ unique: true })` 唯一索引（OR 连接）
3. 以上均无时，回退到主键列（含自增主键）

### 3. DECIMAL/NUMERIC 返回 string，并保留小数位

mysql2 驱动默认将 DECIMAL/NUMERIC 列返回为 `string` 以避免浮点精度丢失，且会保留列定义的小数位（如 `DECIMAL(10,2)` 的 `0` 返回 `"0.00"`）；原版达梦驱动返回 `number`，双数据库环境下类型不一致。

**改动：**
- `connect()` 开启 `extendedMetaData = true`，使查询结果 metaData 包含 `dbTypeName`、`scale` 等类型信息
- `query()` 通过 `dbTypeName` 识别 `DECIMAL`/`DEC`/`NUMERIC` 列，用 `toFixed(scale)` 格式化为 `string`（覆盖 `getRawMany`/`getRawOne`）
- `prepareHydratedValue()` 对 Entity 查询的 `decimal`/`numeric`/`dec` 类型列，同样用 `toFixed(columnMetadata.scale)` 返回 `string`
- `NUMBER` 整数类型不受影响，继续返回 `number`

---

## 安装

```bash
npm install @ylz-api/typeorm-dm
```

**要求：** `typeorm >= 0.3.25`、`uuid >= 9.0.0`（均为 peerDependencies）

## 在主工程中替换原版

在 `package.json` 中使用 npm alias，**无需修改业务代码中的任何 import**：

```json
{
  "dependencies": {
    "typeorm-dm": "npm:@ylz-api/typeorm-dm@^1.0.0"
  }
}
```

## DataSource 配置

```typescript
import "reflect-metadata"
import { DmdbDataSource } from "typeorm-dm"
import { Photo } from "./entity/Photo"

const AppDataSource = new DmdbDataSource({
    type: "oracle",
    innerType: "dmdb",
    host: "localhost",
    port: 5236,
    username: "SYSDBA",
    password: "SYSDBA",
    schema: "SYSDBA",
    // url 优先于 host/port 等参数
    url: "dm://SYSDBA:SYSDBA@localhost:5236?schema=SYSDBA",
    entities: [Photo],
    synchronize: true,
    logging: false,
})

AppDataSource.initialize()
    .then(() => { /* 开始使用 */ })
    .catch((error) => console.log(error))
```

---

## 使用示例

### Upsert（`.orUpdate()`）

```typescript
// QueryBuilder 方式
await dataSource
    .createQueryBuilder()
    .insert()
    .into(User)
    .values({ id: 1, name: "Alice", email: "alice@example.com" })
    .orUpdate(["name", "email"], ["id"])
    .execute()

// Repository.upsert() 方式
await userRepository.upsert(
    { id: 1, name: "Alice", email: "alice@example.com" },
    ["id"]
)
```

生成的 SQL：

```sql
MERGE INTO "SYSDBA"."user" "user"
  USING (SELECT ? AS "name", ? AS "email" FROM DUAL) "s"
  ON ("user"."id" = "s"."id")
WHEN MATCHED THEN UPDATE SET "user"."name" = "s"."name", "user"."email" = "s"."email"
WHEN NOT MATCHED THEN INSERT ("name", "email") VALUES ("s"."name", "s"."email")
```

---

### Insert Ignore（`.orIgnore()`）

```typescript
await dataSource
    .createQueryBuilder()
    .insert()
    .into(Doctor)
    .values([
        { name: "Alice", code: "D001" },
        { name: "Bob",   code: "D002" },
    ])
    .orIgnore()
    .execute()
```

生成的 SQL（`code` 列有唯一约束，`id` 为自增主键）：

```sql
MERGE INTO "SYSDBA"."doctor" "doctor"
  USING (SELECT ? AS "name", ? AS "code" FROM DUAL
         UNION ALL SELECT ? AS "name", ? AS "code" FROM DUAL) "s"
  ON ("doctor"."code" = "s"."code")
WHEN NOT MATCHED THEN INSERT ("name", "code") VALUES ("s"."name", "s"."code")
```

---

### DECIMAL 列返回 string

无需任何业务代码改动，装好新版驱动后自动生效：

```typescript
// getRawMany 场景
const list = await repo
    .createQueryBuilder("t")
    .select(["t.price", "t.amount"])
    .getRawMany()
console.log(typeof list[0].t_price)   // "string"

// getMany 场景
const entities = await repo.find()
console.log(typeof entities[0].price) // "string"
```

---

## Change Logs

### v1.0.9
- 修复 DECIMAL/NUMERIC 列转 string 时丢失小数位的问题（如 `0` → `"0.00"`）
  - `query()`：利用 `extendedMetaData` 中的 `scale` 字段，改用 `toFixed(scale)` 格式化（Raw 查询路径）
  - `prepareHydratedValue()`：利用 `columnMetadata.scale`，改用 `toFixed(scale)` 格式化（Entity 查询路径）

### v1.0.8
- 新增 DECIMAL/NUMERIC 类型返回 `string`，与 mysql2 默认行为对齐，避免 JS 浮点精度丢失
  - `connect()`：开启 `extendedMetaData = true`
  - `query()`：通过 `dbTypeName` 识别 `DECIMAL`/`DEC`/`NUMERIC` 列转为 `string`（覆盖 Raw 查询路径）
  - `prepareHydratedValue()`：Entity 查询路径同步处理

### v1.0.7
- 改进 `orIgnore()` ON 条件推断：收集所有 `@Unique` / `@Index({ unique: true })` 约束（OR 连接），无唯一约束时回退到主键列

### v1.0.5
- 修复 `orIgnore()` 中 IDENTITY 列被错误纳入 INSERT 列表导致达梦 -2723 的 bug
- 修复无主键且无唯一约束时生成 `ON ()` 空条件的 bug
- 新增无 Entity 元数据时的前置保护

### v1.0.4
- 新增 `orIgnore()` 达梦兼容支持，转换为 `MERGE INTO ... WHEN NOT MATCHED THEN INSERT`

### v1.0.1
- 将 `uuid` 调整为 `peerDependencies`

### v1.0.0（fork 起点）
- 基于 typeorm-dm@1.0.43524 fork
- 新增 MERGE INTO upsert 支持（`supportedUpsertTypes: ["merge-into"]`）
- 新增 `createDmMergeExpression()` 方法
- `peerDependencies` 改为 `typeorm: "^0.3.25"`

### 原版 typeorm-dm v1.0.43524（2025-11-14）
- 因 dmdb 绑出参数格式策略调整，同步升级

### 原版 typeorm-dm v1.0.34946（2025-04-07）
- 因 dmdb 自动提交配置策略改变，同步修改 typeorm-dm
