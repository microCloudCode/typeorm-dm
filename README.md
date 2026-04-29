# @ylz-api/typeorm-dm

> Fork 自 [typeorm-dm@1.0.43524](https://www.npmjs.com/package/typeorm-dm)，新增 **MERGE INTO upsert** 和**标识符自动转义**支持。

达梦数据库驱动 [dmdb](https://www.npmjs.com/package/dmdb) 适配 [TypeORM](https://www.npmjs.com/package/typeorm) 框架的方言包。

## 与原版的区别

### 1. MERGE INTO upsert 支持

原版 `typeorm-dm` 缺少 TypeORM 0.3.25+ 的 `merge-into` upsert 路径，
导致在达梦上调用 `.orUpdate()` 报错 `"onUpdate is not supported by the current database driver"`。

本 fork 的改动：

- `DmdbDriver.js` — `supportedUpsertTypes` 改为 `["merge-into"]`
- `DmdbInsertQueryBuilder.js` — `createInsertExpression()` 增加分流，当 `onUpdate` 存在且为 merge-into 类型时，走新的 `createDmMergeExpression()` 方法
- 新增 `createDmMergeExpression()` — 生成达梦兼容的 `MERGE INTO` 语句，正确处理 IDENTITY 列的自动排除和 `SET IDENTITY_INSERT ON/OFF`

### 2. 标识符自动转义

达梦在 Oracle 兼容模式下，未加双引号的标识符会被自动折叠为大写，
导致 QueryBuilder 中开发者手写的裸条件（如 `.where("doctor.departmentId = :id")`）中的
`doctor.departmentId` 变成 `DOCTOR.DEPARTMENTID`，与驼峰命名的列不匹配，查询报错。

本 fork 在 `escapeQueryWithParameters` 中新增 `autoEscapeRawIdentifiers` 静态方法，
在 SQL 发送给数据库前，自动将 `alias.column` 形式转义为 `"alias"."column"`。

规则：
- 仅处理裸标识符（字母/数字/下划线组成的 `word.word` 或 `word.*`）
- TypeORM 自动生成的已转义部分（如 `"schema"."table"`）不受影响
- 参数占位符（`:paramName`）不含点，不受影响

```
doctor.departmentId = :id  →  "doctor"."departmentId" = :id
department.name LIKE :kw   →  "department"."name" LIKE :kw
doctor.*                   →  "doctor".*
"SD_JKTJ"."s_doctor"       →  不变
```

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

## 标识符转义示例

```typescript
// 无需任何额外配置，以下写法在达梦上会自动转义
await dataSource
    .createQueryBuilder(Doctor, "doctor")
    .leftJoinAndSelect("doctor.department", "department")
    .where("doctor.departmentId = :id", { id: 1 })
    .andWhere("doctor.status = :status", { status: "active" })
    .getMany()

// 生成的 SQL（达梦收到的）：
// SELECT ... WHERE "doctor"."departmentId" = ? AND "doctor"."status" = ?
```

## Change Logs

### v1.0.2
- 新增标识符自动转义功能（`autoEscapeRawIdentifiers`），解决达梦 Oracle 模式下大写折叠问题

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
