# typeorm-dm

此包为达梦数据库驱动 [dmdb](https://www.npmjs.com/package/dmdb) 适配 [typeorm](https://www.npmjs.com/package/typeorm) 框架的方言包，使用方法：

```typescript
import "reflect-metadata"
import { DmdbDataSource } from "typeorm-dm"
import { Photo } from "./entity/Photo"

// 注意：区别于typeorm根据选项中的type字段自动加载数据库驱动，
// 达梦方言包必须手动指定DmdbDataSource类型的数据源！
const AppDataSource = new DmdbDataSource({
    type: "oracle",
    innerType: "dmdb",
    host: "localhost",
    port: 5236,
    username: "SYSDBA",
    password: "SYSDBA",
    schema: "SYSDBA",
    // url优先于host/port/username等参数，建议使用url，因为可以支持更多自定义连接串参数
    url: "dm://SYSDBA:SYSDBA@localhost:5236?schema=SYSDBA",
    entities: [Photo],
    synchronize: true,
    logging: false,
})

// to initialize the initial connection with the database, register all entities
// and "synchronize" database schema, call "initialize()" method of a newly created database
// once in your application bootstrap
AppDataSource.initialize()
    .then(() => {
        // here you can start to work with your database
    })
    .catch((error) => console.log(error))
```

## Change Logs

### typeorm-dm v1.0.43524(2025-11-14)
- 因dmdb绑出参数格式策略调整，同步升级

### typeorm-dm v1.0.34946(2025-04-07)
- 因dmdb自动提交配置策略改变，同步修改typeorm-dm

### typeorm-dm v1.0.26038(2024-06-12)
- 去除对oracledb模块的运行时依赖

### typeorm-dm v1.0.25820(2024-05-30)
- 支持列类型enum和simple-enum，实现方法为转化成数据库的varchar类型并添加检查约束，限制取值在枚举范围内
  ```
  in typeorm:
    @Column({ type: "simple-enum", enum: ["admin", "user"] })
    role: string;
  ---------------------------------------------
  in database:
    "role" varchar NOT NULL CONSTRAINT "CHK_xxxxx_ENUM" CHECK("role" IN ('admin','user'))
  ```

### typeorm-dm v1.0.25580(2024-05-21)
- 修复绑定参数占位符问号和冒号混用问题

### typeorm-dm v1.0.25075(2024-04-30)
- 发布正式版
- 支持流方式读取结果集

### typeorm-dm v0.0.1(2024-04-26)
- 测试版，已跑通typeorm源码测例