/**
 * @file Wrap idb apis for idb-managed
 */
import { CustomDB } from './index';
import { openDB as IDBOpenDB, deleteDB as IDBDeleteDB } from 'idb';
import { deduplicateList } from './lib/utils';
import FormattedResult from './lib/formatted_result';
const IDB_MANAGER_DB_NAME = 'IDB_MANAGER_DB';
const IDB_MANAGER_DB_TABLE_NAME = 'IDB_MANAGER_STORE';
const IDB_MANAGER_DB_TABLE_INDEX_NAME = 'dbName';
const UPDATETIME_KEYNAME = 'updateTime';
const EXPIRETIME_KEYNAME = 'expireTime';
function indexRange2DBKey(indexRange: IndexRange) {
    const {
        onlyIndex,
        lowerIndex,
        upperIndex,
        lowerExclusive = false,
        upperExclusive = false
    } = indexRange;
    if (onlyIndex !== undefined) {
        return IDBKeyRange.only(onlyIndex);
    } else if (lowerIndex !== undefined && upperIndex !== undefined) {
        return IDBKeyRange.bound(
            lowerIndex,
            upperIndex,
            lowerExclusive,
            upperExclusive
        );
    } else if (lowerIndex !== undefined) {
        return IDBKeyRange.lowerBound(lowerIndex, lowerExclusive);
    } else {
        return IDBKeyRange.upperBound(upperIndex, upperExclusive);
    }
}

function itemWrapper(itemConfig: ItemConfig): ItemInTable {
    const currentTime = Date.now();
    return {
        ...itemConfig.item,
        ...{
            [UPDATETIME_KEYNAME]: currentTime,
            [EXPIRETIME_KEYNAME]:
                itemConfig.itemDuration !== undefined
                    ? itemConfig.itemDuration + currentTime
                    : -1
        }
    };
}

function itemUnwrapper(item: ItemInTable) {
    if (!item) {
        return null;
    } else if (item.expireTime > 0 && item.expireTime < Date.now()) {
        return null;
    } else {
        delete item.updateTime;
        delete item.expireTime;
        return item;
    }
}

async function registerDBInManager(dbInfo: DB) {
    const dbManager = await openDBManager();
    const dbAlreadyInManager = ((await getItemFromDB(
        dbManager as any,
        IDB_MANAGER_DB_TABLE_NAME,
        dbInfo.name
    )) as any) as ItemInDBManager
    if (dbAlreadyInManager && dbInfo.version <= dbAlreadyInManager.version) {
        // No need to register
        return;
    } else {
        // update db in manager
        const addDBTrans = dbManager.transaction(IDB_MANAGER_DB_TABLE_NAME, 'readwrite');
        const table = addDBTrans.objectStore(IDB_MANAGER_DB_TABLE_NAME)
        const dbItem: ItemInDBManager = {
            dbName: dbInfo.name,
            tableList: dbInfo.tableList,
            version: dbInfo.version
        }
        table.put(itemWrapper({
            item: dbItem,
            tableName: IDB_MANAGER_DB_TABLE_NAME
        }));
        await addDBTrans.done;
        dbManager.close();    
    }
}

async function unregisterDBInManager(dbName: string) {
    const dbManager = await openDBManager();
    const deleteTrans = dbManager.transaction(IDB_MANAGER_DB_TABLE_NAME, 'readwrite');
    const table = deleteTrans.objectStore(IDB_MANAGER_DB_TABLE_NAME);
    table.delete(dbName);
    await deleteTrans.done;
    dbManager.close();
}

async function createDB(dbInfo: DB) {
    await registerDBInManager(dbInfo);
    const db = await IDBOpenDB(dbInfo.name, dbInfo.version as number, {
        upgrade(upgradeDB, oldVersion, newVersion, transaction) {
            upgradeDBWithTableList(upgradeDB as any, dbInfo.tableList, transaction);
        }
    });
    return db;
}

async function openDBManager() {
    return await IDBOpenDB(IDB_MANAGER_DB_NAME, 1, {
        // In case DB Manager has not been created.
        upgrade(upgradeDB) {
            upgradeDBManager(upgradeDB as any);
        }
    });
}

async function openDB(dbName: string) {
    const dbManager = await openDBManager();
    const dbAlreadyInManager = ((await getItemFromDB(
        dbManager as any,
        IDB_MANAGER_DB_TABLE_NAME,
        dbName
    )) as any) as ItemInDBManager | null;
    dbManager.close();
    if (dbAlreadyInManager) {
        const db = await IDBOpenDB(dbAlreadyInManager.dbName, dbAlreadyInManager.version as number, {
            // In case this DB has not been created.
            upgrade(upgradeDB, oldVersion, newVersion, transaction) {
                upgradeDBWithTableList(
                    upgradeDB as any,
                    dbAlreadyInManager.tableList || [],
                    transaction
                );
            }
        });
        return db;
    } else {
        throw FormattedResult['DB_NOT_FOUND'];
    }
}

async function getItemFromDB(
    db: IDBDatabase,
    tableName: string,
    primaryKeyValue: any
) {
    if (db.objectStoreNames.contains(tableName)) {
        const trans = db.transaction(tableName, 'readonly');
        const table = trans.objectStore(tableName);
        const itemInTable = ((await table.get(
            primaryKeyValue
        )) as any) as ItemInTable;
        return itemUnwrapper(itemInTable);
    } else {
        throw FormattedResult['TABLE_NOT_FOUND'];
    }
}

function upgradeDBManager(upgradeDB: IDBDatabase) {
    upgradeDB.createObjectStore(IDB_MANAGER_DB_TABLE_NAME, {
        keyPath: IDB_MANAGER_DB_TABLE_INDEX_NAME
    });
}

function upgradeDBWithTableList(
    upgradeDB: IDBDatabase,
    tableList: TableConfig[],
    transaction: any
) {
    try {
        tableList.forEach(tableConfig => {
            // If table already exists.
            if (
                upgradeDB.objectStoreNames.contains(
                    tableConfig.tableName
                )
            ) {
                const currentTable = transaction.objectStore(
                    tableConfig.tableName
                );
                // Create new index for present table.
                (tableConfig.indexList || []).forEach(
                    (theIndex: IndexOfTable) => {
                        if (
                            !currentTable.indexNames.contains(
                                theIndex.indexName
                            )
                        ) {
                            currentTable.createIndex(
                                theIndex.indexName,
                                theIndex.indexName,
                                { unique: theIndex.unique }
                            );
                        }
                    }
                );
                // Else create new table.
            } else {
                const tablePrimaryKey = tableConfig.primaryKey || 'id';
                const tableToCreate = upgradeDB.createObjectStore(
                    tableConfig.tableName,
                    {
                        ...{ keyPath: tablePrimaryKey },
                        ...(tablePrimaryKey === 'id'
                            ? { autoIncrement: true }
                            : {})
                    }
                );
                // Set index of primaryKey.
                tableToCreate.createIndex(tablePrimaryKey, tablePrimaryKey, {
                    unique: true
                });
                // Set indexes defined in tableConfig
                (tableConfig.indexList || []).forEach(
                    (theIndex: IndexOfTable) => {
                        tableToCreate.createIndex(
                            theIndex.indexName,
                            theIndex.indexName,
                            { unique: theIndex.unique }
                        );
                    }
                );
                // Set index of updateTime for data ordering priority.
                tableToCreate.createIndex(
                    UPDATETIME_KEYNAME,
                    UPDATETIME_KEYNAME,
                    { unique: false }
                );
                // Set index of expireTime for expired data deletion.
                tableToCreate.createIndex(
                    EXPIRETIME_KEYNAME,
                    EXPIRETIME_KEYNAME,
                    { unique: false }
                );
            }
        });
    } catch (e) {
        console.log(e);
        upgradeDB.close(); // Close upgraded DB to trigger the failure of this opening process.
    }
}

export async function addItems(customDB: CustomDB, items: ItemConfig[]) {
    const db = await createDB(customDB);
    const dedupTableNameList = deduplicateList(
        items.map(item => item.tableName)
    );
    const addItemsTrans = db.transaction(dedupTableNameList, 'readwrite');
    items.forEach(item => {
        const table = addItemsTrans.objectStore(item.tableName);
        table.put(itemWrapper(item));
    });
    await addItemsTrans.done;
    db.close();
}

export async function getItem(
    dbName: string,
    tableName: string,
    primaryKeyValue: any
) {
    const db = await openDB(dbName);
    const item = await getItemFromDB(
        (db as any) as IDBDatabase,
        tableName,
        primaryKeyValue
    );
    db.close();
    return item;
}

export async function getItemsInRange(
    dbName: string,
    tableName: string,
    indexRange?: IndexRange
) {
    const db = await openDB(dbName);
    if (db.objectStoreNames.contains(tableName)) {
        const trans = db.transaction(tableName, 'readonly');
        const table = trans.objectStore(tableName);
        // Get all items in table if indexRange is undefined
        if (!indexRange) {
            let items = await table.getAll();
            return (items || []).map(itemUnwrapper);
        } else {
            let index = table.index(indexRange.indexName);
            let cursor = await index.openCursor(indexRange2DBKey(indexRange));
            let items = [];
            while (cursor) {
                items.push(itemUnwrapper(cursor.value));
                cursor = await cursor.continue();
            }
            db.close();
            return items;
        }
    } else {
        db.close();
        throw FormattedResult['TABLE_NOT_FOUND'];
    }
}

export async function deleteDB(dbName: string) {
    await unregisterDBInManager(dbName);
    await IDBDeleteDB(dbName);
}

export default {
    addItems,
    getItem,
    getItemsInRange,
    deleteDB
};