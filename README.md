# @ylz-api/typeorm-dm

> Fork 自 [typeorm-dm@1.0.43524](https://www.npmjs.com/package/typeorm-dm)，新增 **MERGE INTO upsert** 和 **orIgnore 兼容**支持。

达梦数据库驱动 [dmdb](https://www.npmjs.com/package/dmdb) 适配 [TypeORM](https://www.npmjs.com/package/typeorm) 框架的方言包。

## 与原版的区别

### 1. MERGE INTO upsert 支持

原版缺少 TypeORM 0.3.25+ 的 `merge-into` upsert 路径，
导致 `.orUpdate()` 报错 `"onUpdate is not supported by the current database driver"`。

- `DmdbDriver.js` — `supportedUpsertTypes` 改为 `["merge-into"]`
- `createInsertExpression()` 增加分流，当 `onUpdate` 存在且为 merge-into 类型时，走 `createDmMergeExpression()`
- 新增 `createDmMergeExpression()` — 生成达梦兼容的 `MERGE INTO` 语句，正确处理 IDENTITY 列的自动排除和 `SET IDENTITY_INSERT ON/OFF`

### 2. orIgnore 兼容支持

达梦不支持 `INSERT IGNORE INTO`，调用 `.orIgnore()` 会报 `[-6602] 违反唯一性约束`。

- `createInsertExpression()` 检测到 `onIgnore` 时，分流到 `createDmMergeExpressionForIgnore()`
- 新增 `createDmMergeExpressionForIgnore()` — 生成不含 `WHEN MATCHED` 子句的 `MERGE INTO`，
  命中唯一约束时跳过（等效 INSERT IGNORE），未命中时正常插入
- ON 条件列自动检测优先级：唯一约束（`metadata.uniques`）> 唯一索引（`metadata.indices`）> 主键列

## 安装

```bash
npm install @ylz-api/typeorm-dm
```

**要求：** `typeorm >= 0.3.25`

## 在主工程中替换原版

在 `package.json` 中使用 npm alias，**无需修改业务代码中的任何 import**：

```json
{
  "dependencies": {
    "typeorm-dm": "npm:@ylz-api/typeorm-dm@^1.0.0"
  }
}
```

## 使用方法

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

## Upsert 示例

```typescript
// QueryBuilder .orUpdate() 方式
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

## orIgnore 示例

```typescript
// 冲突时跳过，不报错
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

// 生成的 SQL（code 列有唯一约束时）：
// MERGE INTO "SYSDBA"."s_doctor" "s_doctor"
//   USING (SELECT ? AS "name", ? AS "code" FROM DUAL
//          UNION ALL SELECT ? AS "name", ? AS "code" FROM DUAL) "s"
//   ON ("s_doctor"."code" = "s"."code")
//   WHEN NOT MATCHED THEN INSERT ("name", "code") VALUES ("s"."name", "s"."code")
```

## Change Logs

### v1.0.4
- 新增 `orIgnore()` 达梦兼容支持，转换为 `MERGE INTO ... WHEN NOT MATCHED THEN INSERT`

### v1.0.3
- 撤回 v1.0.2 的标识符自动转义功能（`autoEscapeRawIdentifiers`）

### v1.0.2
- 新增标识符自动转义功能（`autoEscapeRawIdentifiers`），解决达梦 Oracle 模式下大写折叠问题（已在 v1.0.3 撤回）

### v1.0.1
- 将 `uuid` 调整为 `peerDependencies`

### v1.0.0 (fork)
- 基于 typeorm-dm@1.0.43524 fork
- 新增 MERGE INTO upsert 支持（`supportedUpsertTypes: ["merge-into"]`）
- 新增 `createDmMergeExpression()` 方法
- `peerDependencies` 改为 `typeorm: "^0.3.25"`

### 原版 typeorm-dm v1.0.43524 (2025-11-14)
- 因 dmdb 绑出参数格式策略调整，同步升级

### 原版 typeorm-dm v1.0.34946 (2025-04-07)
- 因 dmdb 自动提交配置策略改变，同步修改 typeorm-dm


## 安装

```bash
npm install @ylz-api/typeorm-dm
```

**要求：** `typeorm >= 0.3.25`

## 在主工程中替换原版

在 `package.json` 中使用 npm alias，**无需修改业务代码中的任何 import**：

```json
{
  "dependencies": {
    "typeorm-dm": "npm:@ylz-api/typeorm-dm@^1.0.0"
  }
}
```

## 使用方法

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

## Upsert 示例

```typescript
// QueryBuilder .orUpdate() 方式
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

## Change Logs

### v1.0.3
- 撤回 v1.0.2 的标识符自动转义功能（`autoEscapeRawIdentifiers`）

### v1.0.2
- 新增标识符自动转义功能（`autoEscapeRawIdentifiers`），解决达梦 Oracle 模式下大写折叠问题（已在 v1.0.3 撤回）

### v1.0.1
- 将 `uuid` 调整为 `peerDependencies`

### v1.0.0 (fork)
- 基于 typeorm-dm@1.0.43524 fork
- 新增 MERGE INTO upsert 支持（`supportedUpsertTypes: ["merge-into"]`）
- 新增 `createDmMergeExpression()` 方法
- `peerDependencies` 改为 `typeorm: "^0.3.25"`

### 原版 typeorm-dm v1.0.43524 (2025-11-14)
- 因 dmdb 绑出参数格式策略调整，同步升级

### 原版 typeorm-dm v1.0.34946 (2025-04-07)
- 因 dmdb 自动提交配置策略改变，同步修改 typeorm-dm
