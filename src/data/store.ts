import {Injectable} from "@angular/core";
import {Schema} from "./schema";
import {SQLite, SQLiteObject} from "@ionic-native/sqlite";
import {DB_NAME, ENTITIES_TO_EXCLUDE} from "../constants";
import {Observable} from "rxjs/Observable";
import {Logger} from "../helper/logger";
import uuid  from 'uuid/v1';
import {QueueType} from "./queuetype";
import {User} from "../auth/user";



@Injectable()
export class Store {

  private _db : SQLiteObject = null;
  private user : User = null;

  constructor(private sqlite : SQLite, private schema : Schema, private logger : Logger){

  }

  /**
   * Schema einer bestehenden Tabelle anpassen
   * @param {SQLiteObject} db
   * @param entityConfig
   * @param entityOldConfig
   * @returns {Promise<any>}
   */
  private alterTableForEntity(db: SQLiteObject, entityConfig : any, entityOldConfig : any){

    let dbName: string = entityConfig.settings.dbname;

    let tempProperties : string[] = [];
    for (let property in entityOldConfig.properties) {
      if(!entityConfig.properties[property]){
        continue;
      }
      if(entityConfig.properties[property]['type'] == 'multijoin' || entityConfig.properties[property]['type'] == 'multifile'){
        continue
      }
      if(entityConfig.properties[property]['type'] == 'join'){
        tempProperties.push('`' + property + '_id' + '`');
        continue;
      }
      if(entityConfig.properties[property]['type'] == 'file'){
        tempProperties.push('`file_id`');
        continue;
      }

      tempProperties.push('`' + property + '`');
    }

    let statements = [
      'CREATE TABLE IF NOT EXISTS temp_' + dbName + ' AS SELECT ' + tempProperties.join(',') + ' FROM ' + dbName,
      'DROP TABLE IF EXISTS ' + dbName
    ];

    let promise = db.sqlBatch(statements).then(() => {
      //Bestehende Tabelle wurde in Temp-Tabelle kopiert

      return this.createTableForEntity(db, entityConfig).catch((error) => {
        db.executeSql('ALTER TABLE temp_' + dbName + ' RENAME TO ' + dbName, []);

        return Promise.reject(error);
      });
    }).then(() => {
      //Neue Tabelle wurde angelegt und Daen kopiert

      let subStatements = [
        'INSERT INTO ' + dbName + '(' + tempProperties.join(',') + ') SELECT ' + tempProperties.join(',') + ' FROM temp_' + dbName,
        'DROP TABLE temp_' + dbName
      ];

      return db.sqlBatch(subStatements).catch((error) => {
        db.sqlBatch([
          'DROP TABLE IF EXISTS ' + dbName,
          'ALTER TABLE temp_' + dbName + ' RENAME TO ' + dbName,
        ]);

        return Promise.reject(error);
      });
    });

    return promise;

  }

  /**
   * Ausführen von mehreren SQL-Kommandoes im Batch-Modus
   * @param {any[]} commands
   * @returns {Promise<SQLiteObject>}
   */
  public batch(commands : any[]){
    let promise = this.db().then((db) => {
      return db.sqlBatch(commands);
    });

    return promise;
  }

  /**
   * Bool auf Integer casten
   * @param value
   * @returns {number}
   */
  private boolVal2Int(value: any) {
    value = String(value);

    switch(value.toLowerCase().trim()){
      case "true": case "yes": case "1": return 1;
      case "false": case "no": case "0": case null: return 0;
      default: 0;
    }
  }

  /**
   * Erstellt die Tabelle für eine Entität
   * @param {SQLiteObject} db
   * @param entityConfig
   * @returns {Promise<void>}
   */
  private createTableForEntity(db: SQLiteObject, entityConfig : any){


    let dbName: string = entityConfig.settings.dbname;
    let createTableString: string = "CREATE TABLE `" + dbName + "` (";
    let propertiesCreateStatement: string[] = [];

    let statements = [];

    if(dbName == 'pim_file'){
      entityConfig.properties['_hashLocal'] = {
        'type' : 'string',
      }
    }

    for (let property in entityConfig.properties) {
      let propertyConfig: any = entityConfig.properties[property];
      let type: string = propertyConfig.type;
      let dbtype: string = "";
      let special: string = "";

      switch (type) {
        case "virtualjoin":
          dbtype = "TEXT";
          break;
        case "checkbox":
        case "boolean":
          dbtype = "INTEGER";
          break;
        case "join":
        case "file":
          dbtype = "TEXT";
          property =  property + '_id';
          break;
        case "multifile":
          var joinedTableNameMF = propertyConfig.foreign ? propertyConfig.foreign :  propertyConfig.dbName + "_" + property;
          var sqlMF = "CREATE TABLE IF NOT EXISTS `" + joinedTableNameMF + "` (`" + dbName.replace('_', '') + "_id` TEXT NOT NULL, `file_id` TEXT NOT NULL, PRIMARY KEY (`" + dbName.replace('_', '') + "_id`, `file_id`))";

          statements.push([sqlMF, []]);
          break;
        case "multijoin":
          if(!propertyConfig.foreign){
            continue;
          }

          var joinedTableName = propertyConfig.foreign;
          var joinedEntity = propertyConfig.accept.substr(0, 13) == 'Custom\\Entity'
            ? propertyConfig.accept.substr(14)
            : propertyConfig.accept.replace('Areanet\\PIM\\Entity', 'PIM');
          var joinedEntityDbname = this.schema.data[joinedEntity].settings.dbname;
          var sql = "CREATE TABLE IF NOT EXISTS `" + joinedTableName + "` (`" + dbName.replace('_', '') + "_id` TEXT NOT NULL, `" + joinedEntityDbname.replace('_', '') + "_id` TEXT NOT NULL, PRIMARY KEY (`" + dbName.replace('_', '') + "_id`, `" + joinedEntityDbname.replace('_', '') + "_id`))";

          statements.push([sql, []]);

          continue;
        case "decimal":
          dbtype = "FLOAT";
        case "string":
        case "datetime":
        case "date":
        case "time":
          dbtype = "TEXT";
          break;
        default:
          dbtype = propertyConfig.dbtype;
          break
      }

      if (property == "id") {
        special = "PRIMARY KEY NOT NULL";
      } else if (propertyConfig.nullable === false) {
        special = "NOT NULL";
      }

      propertiesCreateStatement.push("`" + property + "` " + dbtype + " " + special);

    }

    createTableString += propertiesCreateStatement.join(", ");
    createTableString += ")";

    statements.push([createTableString, []]);

    return db.sqlBatch(statements).then(() => {
      return Promise.resolve();
    }).catch((error) => {
      if(error.code == 5){
        return Promise.resolve();
      }else{
        return Promise.reject(error);
      }
    });
  }

  /**
   * Gibt die Datenbank-Instanz zurück
   * @returns {Promise<SQLiteObject>}
   */
  public db(){
    if(this._db != null){
      return Promise.resolve(this._db);
    }else {
      return this.sqlite.create({
        name: DB_NAME,
        location: 'default'
      }).then((db: SQLiteObject) => {
        this._db = db;
        this.logger.info("DB.CREATED/OPENED ", DB_NAME);
        return Promise.resolve(this._db);
      }).catch(error => {
        this.logger.error("DB.CREATED/OPENED ", error.toString());
        return Promise.reject(error);
      });
    }
  }

  /**
   * Löscht einen Datensatz einer Entität
   * @param {string} entityName
   * @param {string} id
   * @param {boolean} noQueueing
   * @returns {Promise<void>}
   */
  public delete(entityName : string, id : string, noQueueing : boolean = false){
    let promise = this.db().then((db) => {
      let entityConfig = this.schema.data[entityName];
      if (!entityConfig) {
        this.logger.error("store.delete::" + entityName + ": nicht vorhanden", id);
        return Promise.reject("store.delete::" + entityName + ": nicht vorhanden");
      }

      let dbName             = entityConfig.settings.dbname;
      let statement = "DELETE FROM `" + dbName + "` WHERE id = ?";

      return db.executeSql(statement, [id]).then(() => {
        this.logger.info("store.delete::" + entityName, id);
        if(!noQueueing){
          return this.insertQueue(entityName, id, QueueType.deleted);
        }else{
          return Promise.resolve();
        }

      }).catch((error) => {
        this.logger.error("store.delete::" + entityName + ":" +id, error);
        return Promise.reject(error);
      })
    });

    return promise;
  }

  /**
   * LÖscht Objekte aus Rückgabe von api/deleted
   * @param {any[]} objects
   * @returns {Promise<any>}
   */
  public deleteObjects(objects : any[]) {

    let promises = [];

    for (let object of objects) {
      let model_name = object['model_name'];
      let model_id = object['model_id'];

      let p = this.delete(model_name, model_id, true).catch((error) => {
        return Promise.resolve();
      });
      promises.push(p);
    }

    return Promise.all(promises);
  }

  /**
   * Löscht die Datenbank, z.B. beim Logout
   */
  public deleteDatabase(){
    this._db  = null;

    this.sqlite.deleteDatabase({
      name: DB_NAME,
      location: 'default'
    }).then(() => {

    }).catch(() => {

    });
  }

  /**
   * Importiert mehrere Datensätzte einer Entität
   * @param {string} entity
   * @param {any[]} data
   * @returns {Observable<any>}
   */
  public import(entity: string, data : any[]){
    let observer = new Observable(observer => {

      this.db().then((db) => {
          let properties : any[] = this.schema.data[entity].properties;
          let dbName : string    = this.schema.data[entity].settings.dbname;

          let fieldsStatement : string[] = [];
          let placeholderStatement : string[] = [];

          for (let field in properties) {
            let propertyConfig : any[] = properties[field];
            let type : string = propertyConfig['type'];
            if(type == "multijoin" || type == "multifile"){
              continue
            }

            if(type == "file" || type == "join"){
              field =  field + '_id';
            }

            fieldsStatement.push(field);
            placeholderStatement.push("?");
          }

          let preparedSQLStatement = "REPLACE INTO `" + dbName + "`(" + fieldsStatement.join(",") + ") VALUES(" + placeholderStatement.join(",") + ")";
          let batchStatements : any[] = [];

          for (let props of data) {

            let valueStatement: any[] = [];

            for (let field in props) {
              let rawValue = props[field];
              let stmtColInt = fieldsStatement.indexOf(field);
              let fieldForConfig = field;

              if(field.substr(field.length - 3) == '_id'){
                fieldForConfig = field.substr(0, field.length - 3);
              }

              let propertyConfig = properties[fieldForConfig];

              if (stmtColInt == -1 || !propertyConfig) {
                continue;
              }

              let type: string = propertyConfig['type'];
              switch(type){
                case 'multijoin':
                case 'multifile':
                  break;
                case "checkbox":
                case "boolean":
                  //console.log(fieldForConfig + " == " + rawValue + " == " + this.boolVal(rawValue));
                  valueStatement[stmtColInt] = this.boolVal2Int(rawValue);
                  break;
                default:
                  valueStatement[stmtColInt] = rawValue;
                  break;
              }

            }

            batchStatements.push([preparedSQLStatement, valueStatement]);
            observer.next();
          }

          return db.sqlBatch(batchStatements);
      }).then(() => {
        observer.complete();
      }).catch((error) => {
        this.logger.error("SYNC store.import::" + entity, error);
        observer.complete();
      });
    });

    return observer;
  }

  /**
   * Importiert mehrere Datensätze einer Multijoin-Tabelle
   * @param {string} tableName
   * @param {any[]} data
   * @returns {Observable<any>}
   */
  importMultijoin(tableName: string, data : any[]){
    let observer = new Observable(observer => {

      this.db().then((db) => {
        let fieldsStatement : string[] = [];
        let placeholderStatement : string[] = [];

        for (let fieldName in data[0]) {
          fieldsStatement.push(fieldName);
          placeholderStatement.push("?");
        }

        let preparedSQLStatement = "REPLACE INTO `" + tableName + "`(" + fieldsStatement.join(",") + ") VALUES(" + placeholderStatement.join(",") + ")";

        let batchStatements : any[] = [];

        for (let props of data) {

          let valueStatement: any[] = [];

          for (let fieldName in props) {
            let rawValue   = props[fieldName];
            let stmtColInt = fieldsStatement.indexOf(fieldName);
            valueStatement[stmtColInt] = rawValue;
          }

          batchStatements.push([preparedSQLStatement, valueStatement]);
          observer.next();
        }

        return db.sqlBatch(batchStatements);

      }).then(() => {
        observer.complete();
      }).catch((error) => {
        this.logger.error("SYNC store.importMultijoin::" + tableName, error);
        observer.complete();
      });
    });

    return observer;
  }

  /**
   * Fügt einen neuen Datensatz einer Entität ein
   * @param {string} entityName
   * @param data
   * @returns {Promise<string>}
   */
  public insert(entityName : string, data : any){
    let returnId : string  = null;

    let promise = this.db().then((db) => {

      let entityConfig = this.schema.data[entityName];
      if (!entityConfig) {
        this.logger.error("store.insert::" + entityName + ": nicht vorhanden", data);
        return Promise.reject("store.insert::" + entityName + ": nicht vorhanden");
      }

      let dbName             = entityConfig.settings.dbname;

      let excludedProps      = ['id', 'isIntern'];

      let dataArray = Array.isArray(data) ? data : [data];
      let statements : any[] = [];

      for (var i = 0; i < dataArray.length; i++) {
        let dataObject = dataArray[i];

        let insertFields       = [];
        let insertPlaceholders = [];
        let params             = [];

        let id  :string = uuid();

        if(i == 0){
          returnId = id
        }

        //[{entity_name : entity_id}]
        let joins : any[] = [];

        for (let propName in dataObject) {
          propName = propName.replace('_id', '');
          let propConfig = entityConfig.properties[propName];
          if (!propConfig || excludedProps.indexOf(propName) >= 0 ) continue;

          switch(propConfig['type']){
            case 'datetime':
              if(dataObject[propName] == 'NOW()'){
                insertFields.push("`" + propName + "`");
                insertPlaceholders.push("datetime('now')");
              }else{
                insertFields.push("`" + propName + "`");
                insertPlaceholders.push("?");
                params.push(dataObject[propName]);
              }
              break;
            case 'multifile':
              var joinedTableNameMF       = propConfig.foreign ? propConfig.foreign :  propConfig.dbName + "_" + propName;
              var joinedField             = dbName.replace('_', '') + '_id';

              if(data[propName] != null){
                for(let file of data[propName]){
                  var file_id = (file === Object(file)) ? file['id'] : file;
                  statements.push(["INSERT INTO `" + joinedTableNameMF + "` (`" + joinedField + "`, `file_id`) VALUES(?, ?)", [id, file_id]]);
                  joins.push({entity_name : 'PIM\\File', entity_id: file_id});
                }
              }
              break;
            //@todo: multijoin
            case 'file':
            case 'join':

              propName = propName + '_id';
              insertFields.push("`" + propName + "`");
              insertPlaceholders.push("?");
              params.push(dataObject[propName]);

              let joinedEntity = propConfig['type'] == 'file' ? 'PIM\\File' : propConfig['accept'].replace('Custom\\Entity\\', '');
              joins.push({entity_name : joinedEntity, entity_id: dataObject[propName]});

              break;
            case 'checkbox':
            case 'boolean':
              data[propName] = this.boolVal2Int(dataObject[propName]);
              insertFields.push("`" + propName + "`");
              insertPlaceholders.push("?");
              params.push(dataObject[propName]);
            default:
              insertFields.push("`" + propName + "`");
              insertPlaceholders.push("?");
              params.push(dataObject[propName]);
              break;
          }
        }


        insertFields.push("`isIntern`");
        insertPlaceholders.push("0");
        insertFields.push("`user_id`");
        insertPlaceholders.push("?");
        params.push(this.user.id);
        insertFields.push("`userCreated_id`");
        insertPlaceholders.push("?");
        params.push(this.user.id);
        if(!dataObject['created']) {
          insertFields.push("`created`");
          insertPlaceholders.push("datetime('now')");
        }
        if(!dataObject['modified']) {
          insertFields.push("`modified`");
          insertPlaceholders.push("datetime('now')");
        }
        insertFields.push("`id`");
        insertPlaceholders.push("?");
        params.push(id);

        let statement = "" +
          "INSERT INTO `" + dbName + "` (" + insertFields.join(", ") + ") " +
          "VALUES (" + insertPlaceholders.join(", ") + ")";

        statements.push([statement, params]);

        let queueId : string    = uuid();
        let paramsQueue : any[] = [queueId, entityName, id, QueueType.inserted, JSON.stringify(joins)];
        let statementQueue      = "" +
          "INSERT INTO queue " +
          " (id, entity, entity_id, mode, joins, created, syncErrors) " +
          "VALUES " +
          " (?, ?, ?, ?, ?, datetime('now'), 0)";

        statements.push([statementQueue, paramsQueue]);
      }

      return db.sqlBatch(statements);

    }).then(() => {
      this.logger.info("store.insert::" + entityName + "::" + returnId + " gespeichert", data);
      return Promise.resolve(returnId);
    }).catch((error) =>{
      this.logger.error("store.insert::" + entityName, error);
      return Promise.reject(error);
    });

    return promise;
  }

  /**
   * Fügt eine lokale Änderung in die Synchronisations-Queue ein
   * @param {string} entity
   * @param {string} entity_id
   * @param {QueueType} mode
   * @param {any[]} joins
   */
  private insertQueue(entity : string, entity_id : string, mode : QueueType, joins : any[] = []){
    let promise = this.db().then((db) => {
      let statement = "" +
        "INSERT INTO queue " +
        " (id, entity, entity_id, mode, joins, created, syncErrors) " +
        "VALUES " +
        " (?, ?, ?, ?, ?, datetime('now'), 0)";

      let id  :string = uuid();

      return db.executeSql(statement, [id, entity, entity_id, mode, JSON.stringify(joins)])
    });

    return promise;
  }

  /**
   * Gibt die Queue mit den zu synchronisierenden, lokalen Änderungen zurück
   * @returns {Promise<any[]>}
   */
  public queue(){
    let statement = "" +
      "SELECT * " +
      "FROM `queue` " +
      "ORDER BY `entity_id`, `created` DESC";

    return this.query(statement, []);
  }

  /**
   * Gibt die Queue mit den zu synchronisierenden, lokalen Änderungen zurück
   * @returns {Promise<any[]>}
   */
  public queueClened(){
    let statement = "" +
      "SELECT * " +
      "FROM `queue` " +
      "GROUP BY entity, entity_id " +
      "ORDER BY `entity_id`, `created` DESC";

    return this.query(statement, []);
  }

  /**
   * Ausführen einder Datenbank-Abfrage per SQL
   * @param {string} sqlStatement
   * @param {any[]} params
   * @returns {Promise<any[]>}
   */
  public query(sqlStatement : string, params : any[]) : Promise<any[]>{
    var promise = this.db().then((db) => {
      return db.executeSql(sqlStatement, params).catch((error) => {
        this.logger.error("[store.query] execute ", error);
        return Promise.resolve([]);
      });
    }).then((data) => {
      let items : any[] = [];
      if (data.rows.length > 0) {
        for (var i = 0; i < data.rows.length; i++) {
          items.push(data.rows.item(i));
        }
      }
      return items;
    }).catch((error) => {
      this.logger.error("[store.query] open ", error);
      return Promise.resolve([]);
    });

    return promise;

  }

  /**
   * Setzt den eingeloggten Benutzer
   * @param {User} user
   */
  public setUser(user : User){
    this.user = user;
  }

  /**
   * Gibt einen einzelnen Datensatz einer Entität zurück
   * @param {string} entityName
   * @param {string} id
   * @returns {Promise<any>}
   */
  public single(entityName : string, id : string){
    let entityConfig = this.schema.data[entityName];

    let promise = this.db().then((db) => {
      //Datenbank wurde geöffnet

      if (!entityConfig) {
        this.logger.error("store.single::entity not exists", entityName);
        return Promise.reject("store.single::entity not exists",);
      }

      let fields = ['src.*'];
      let order  = [];
      let joins  = [];
      let dbName = entityConfig.settings.dbname;

      for(let propertyName in entityConfig.properties){
        let propertyConfig = entityConfig.properties[propertyName];

        if(propertyConfig.type == 'multijoin' && propertyConfig.foreign){
          var joinedTableName = propertyConfig.foreign;
          var joinedEntity = propertyConfig.accept.substr(0, 13) == 'Custom\\Entity'
            ? propertyConfig.accept.substr(14)
            : propertyConfig.accept.replace('Areanet\\PIM\\Entity', 'PIM');
          var joinedEntityDbname = this.schema.data[joinedEntity].settings.dbname;

          order.push(propertyName);
          fields.push(propertyName + '.' + joinedEntityDbname.replace('_', '') + '_id AS ' + propertyName);
          joins.push('LEFT JOIN ' + joinedTableName + ' AS ' + propertyName + ' ON src.id = ' + propertyName + '.' + dbName.replace('_', '') + '_id');

        }

        if(propertyConfig.type == 'multifile'){
          var joinedTableNameMF = propertyConfig.foreign ? propertyConfig.foreign :  propertyConfig.dbName + "_" + joinedTableName;
          order.push(propertyName);
          fields.push(propertyName + '.file_id AS ' + propertyName);
          joins.push('LEFT JOIN ' + joinedTableNameMF + ' AS ' + propertyName + ' ON src.id = ' + propertyName + '.' + dbName.replace('_', '') + '_id');
        }
      }

      let statement = "" +
        "SELECT " + fields.join(', ') +
        " FROM `" + dbName + "` AS src " +
        joins.join(' ') +
        " WHERE src.id = ?";

      if(order.length > 0){
        statement += " ORDER BY " + order.join(', ');
      }

      return db.executeSql(statement, [id]);
    }).then((objects) => {
      //Aktueller Datensat wurde geladen

      if(objects.rows.length == 0){
        return Promise.resolve([]);
      }

      let objectCombined = null;

      for (var i = 0; i < objects.rows.length; i++) {
        let object =  objects.rows.item(i);
        for(let propertyName in entityConfig.properties){
          let propertyConfig = entityConfig.properties[propertyName];
          switch(propertyConfig.type){
            case 'join':
              if(object[propertyName + '_id']) {
                object[propertyName] = {
                  'id': object[propertyName + '_id']
                };
              }else{
                object[propertyName] = null;
              }
              delete object[propertyName + '_id'];
              break;
            case 'multijoin':
            case 'multifile':
              if(objectCombined){
                if(!objectCombined[propertyName]){
                  objectCombined[propertyName] = [];
                }
                objectCombined[propertyName].push({'id': object[propertyName]});
                object[propertyName] = objectCombined[propertyName];
              }else{
                object[propertyName] = [{
                  'id': object[propertyName]
                }];
              }
              break;
            case 'checkbox':
            case 'boolean':
              object[propertyName] = object[propertyName] == 1 ? true : false;
            default:
              break;
          }
        }

        if(object['_hashLocal']){
          delete object['_hashLocal'];
        }


        objectCombined = object;
      }

      return Promise.resolve(objectCombined);

    }).catch((error) => {
      this.logger.error('[store.single]', error);
      return Promise.reject({code: 500, error: error});
    });

    return promise;
  }

  /**
   * Aktualisieren eines Datensatzes einer Entität
   * @param {string} entityName
   * @param {{}} data
   * @param {boolean} disableQueueing
   * @returns {Promise<any>}
   */
  public update(entityName : string, data : {}, disableQueueing : boolean = false){

    let entityConfig  = this.schema.data[entityName];
    let joins : any[] = [];

    let promise = this.db().then((db) => {
      //Datenbank wurde geöffnet

      if (!entityConfig) {
        this.logger.error("store.update::" + entityName + ": nicht vorhanden", data);
        return Promise.reject("store.update::" + entityName + ": nicht vorhanden");
      }

      if (!data['id']) {
        this.logger.error("store.update::" + entityName + ": keine ID übergeben", data);
        return Promise.reject('Keine ID übergeben.');
      }

      let dbName = entityConfig.settings.dbname;
      let updateStmt = [];
      let params = [];

      var statements : any[]  = [];

      for (let propName in data) {
        propName = propName.replace('_id', '');

        let propConfig = entityConfig.properties[propName];
        if (!propConfig) continue;

        switch(propConfig['type']){
          case 'datetime':
            if(data[propName] == 'NOW()'){
              updateStmt.push("`" + propName + "` = datetime('now')");

            }else{
              updateStmt.push("`" + propName + "` = ?");
              params.push(data[propName]);
            }
            break;
          case 'multifile':
            var joinedTableNameMF   = propConfig.foreign ? propConfig.foreign :  propConfig.dbName + "_" + propName;

            var joinedField         = dbName.replace('_', '') + '_id';
            statements.push(["DELETE FROM `" + joinedTableNameMF + "` WHERE `" + joinedField + "` = ?", [data['id']]]);

            if(data[propName]){
              for(let file of data[propName]){
                var file_id = (file === Object(file)) ? file['id'] : file;
                statements.push(["INSERT INTO `" + joinedTableNameMF + "` (`" + joinedField + "`, `file_id`) VALUES(?, ?)", [data['id'], file_id]]);
                joins.push({entity_name : 'PIM\\File', entity_id: file_id});
              }
            }
            break;
          //@todo: multijoin
          case 'join':
          case 'file':
            propName = propName + '_id';
            updateStmt.push("`" + propName + "` = ?");
            params.push(data[propName]);

            let joinedEntity = propConfig['type'] == 'file' ? 'PIM\\File' : propConfig['accept'].replace('Custom\\Entity\\', '');
            joins.push({entity_name : joinedEntity, entity_id: data[propName]});

            break;
          case 'checkbox':
          case 'boolean':
            data[propName] = this.boolVal2Int(data[propName]);
            updateStmt.push("`" + propName + "` = ?");
            params.push(data[propName]);
            break;
          default:
            updateStmt.push("`" + propName + "` = ?");
            params.push(data[propName]);
            break;
        }

      }

      //@todo: modified_time

      params.push(data['id']);

      let statement = "" +
        "UPDATE `" + dbName + "` " +
        "SET " + updateStmt.join(", ") +
        "WHERE id = ?";

      statements.push([statement, params]);

      return db.sqlBatch(statements);

    }).then(() => {
      //Datensatz wurde aktualisiert

      this.logger.info("[store.update] " + entityName + ": gespeichert", data);
      if(!disableQueueing){
        return this.insertQueue(entityName, data['id'], QueueType.updated, joins);
      }else{
        return Promise.resolve(data['id']);
      }

    }).catch((error) =>{
      this.logger.error("[store.update] " + entityName, error);
      return Promise.reject(error);
    });

    return promise;
  }

  /**
   * Führt ein Update des Datenbank-Schemas aus
   * @param {Schema} schema
   * @returns {Promise<[any]>}
   */
  public updateSchema(schema: Schema){
    this.schema   = schema;
    let promises  = [];
    let db        = null;

    this.logger.info("SYNC store.updateSchema START ");

    let promise = this.db().then((dbInstance) => {
      //Datenbank wurde geöffnet

      db = dbInstance;

      let statementQueue = "" +
        "CREATE TABLE IF NOT EXISTS `queue` (" +
        "  `id` TEXT PRIMARY KEY NOT NULL," +
        "  `entity` TEXT NOT NULL," +
        "  `entity_id` TEXT NOT NULL," +
        "  `joins` TEXT NULL, " +
        "  `created` TEXT NOT NULL," +
        "  `mode` TEXT NOT NULL," +
        "  `syncErrors` INTEGER NOT NULL" +
        ")";
      return db.executeSql(statementQueue, []);

    }).then(() => {
      //Tabelle Queue wurde erstellt oder ist bereits vorhanden

      let entitiesToCreate = Object.keys(schema.data).length - ENTITIES_TO_EXCLUDE.length;
      let entitiedCreated  = 0;

      if(!this.schema.oldData) {
        for (let key in schema.data) {
          if(ENTITIES_TO_EXCLUDE.indexOf(key) >= 0) continue;
          this.logger.info("SYNC store.updateSchema CREATE ", key);
          let entityConfig: any = schema.data[key];

          promises.push(this.createTableForEntity(db, entityConfig));

        }
      }else{
        for (let key in schema.data) {
          if(ENTITIES_TO_EXCLUDE.indexOf(key) >= 0) continue;

          let entityConfig: any = schema.data[key];

          if (!schema.oldData[key]) {
            this.logger.info("SYNC store.updateSchema CREATE ", key);
            promises.push(this.createTableForEntity(db, entityConfig));

          } else {

            let entityOldConfig: any  = schema.oldData[key];
            this.logger.info("SYNC store.updateSchema UPDATE", key);
            promises.push(this.alterTableForEntity(db, entityConfig, entityOldConfig));
          }
        }
      }

      return Promise.all(promises);
    });

    return promise;
  }
}