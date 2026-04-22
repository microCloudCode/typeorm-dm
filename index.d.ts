import { DataSource } from "typeorm"
import { BaseDataSourceOptions } from "typeorm/data-source/BaseDataSourceOptions"

declare namespace dmdbOrm {
    interface DmdbConnectionCredentialsOptions {
        /**
         * Connection url where perform connection to.
         * e.g. dm://username:password@host:port[?prop1=val1[&prop2=val2]]
         */
        readonly url?: string

        /**
         * Database host.
         */
        readonly host?: string

        /**
         * Database host port.
         */
        readonly port?: number

        /**
         * Database username.
         */
        readonly username?: string

        /**
         * Database password.
         */
        readonly password?: string

        /**
         * Schema name to connect to.
         */
        readonly schema?: string
    }

    interface DmdbConnectionOptions extends BaseDataSourceOptions, DmdbConnectionCredentialsOptions {
        /**
         * Database type. in the name of "oracle"
         */
        readonly type: "oracle"

        readonly innerType: "dmdb"

        /**
         * The driver object
         * This defaults to require("dmdb")
         */
        readonly driver?: any

        /**
         * Replication setup.
         */
        readonly replication?: {
            /**
             * Master server used by orm to perform writes.
             */
            readonly master: DmdbConnectionCredentialsOptions

            /**
             * List of read-from severs (slaves).
             */
            readonly slaves: DmdbConnectionCredentialsOptions[]
        }
    }

    class DmdbDataSource extends DataSource {
        constructor(options: DmdbConnectionOptions);
    }
}

export = dmdbOrm