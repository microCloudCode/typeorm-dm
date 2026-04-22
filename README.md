# @ylz/typeorm-dm

> Fork 自 [typeorm-dm@1.0.43524](https://www.npmjs.com/package/typeorm-dm)，新增 **MERGE INTO** upsert 支持。

达梦数据库驱动 [dmdb](https://www.npmjs.com/package/dmdb) 适配 [TypeORM](https://www.npmjs.com/package/typeorm) 框架的方言包。

## 与原版的区别

原版 `typeorm-dm` 的 `DmdbInsertQueryBuilder` 覆写了 TypeORM 的 `createInsertExpression`，
使用的是 TypeORM 0.3.20 时代的旧代码，缺少 TypeORM 0.3.25+ 新增的 `merge-into` upsert 路径，
导致在达梦上调用 `.orUpdate()` 会报错 `"onUpdate is not supported by the current database driver"`。

本 fork 的改动：

1. `DmdbDriver.js` — `supportedUpsertTypes` 改为 `["merge-into"]`
2. `DmdbInsertQueryBuilder.js` — `createInsertExpression()` 增加分流判断，
   当检测到 `onUpdate` 且 upsertType 为 merge-into 时，走新的 `createDmMergeExpression()` 方法
3. 新增 `createDmMergeExpression()` — 生成达梦兼容的 `MERGE INTO` 语句，
   正确处理 IDENTITY 列的自动排除和 `SET IDENTITY_INSERT ON/OFF`

## 安装

```bash
npm install @ylz/typeorm-dm
```

**要求：** `typeorm >= 0.3.25`

## 在主工程中替换原版

在 `package.json` 中使用 npm alias：

```json
{
  "dependencies": {
    "typeorm-dm": "npm:@ylz/typeorm-dm@^1.0.0"
  }
}
```

这样代码中 `require("typeorm-dm")` / `import ... from "typeorm-dm"` 不需要修改。

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
    url: "dm://SYSDBA:SYSDBA@localhost:5236?schema=SYSDBA",
    entities: [Photo],
    synchronize: true,
    logging: false,
})

AppDataSource.initialize()
    .then(() => {
        // here you can start to work with your database
    })
    .catch((error) => console.log(error))
```

## Upsert 示例

```typescript
// .orUpdate() 方式
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

### v1.0.0 (fork)
- 基于 typeorm-dm@1.0.43524 fork
- 新增 MERGE INTO upsert 支持（`supportedUpsertTypes: ["merge-into"]`）
- 新增 `createDmMergeExpression()` 方法
- `peerDependencies` 改为 `typeorm: "^0.3.25"`

### 原版 typeorm-dm v1.0.43524 (2025-11-14)
- 因dmdb绑出参数格式策略调整，同步升级

### 原版 typeorm-dm v1.0.34946 (2025-04-07)
- 因dmdb自动提交配置策略改变，同步修改typeorm-dm