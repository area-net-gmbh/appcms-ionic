import {Injectable} from "@angular/core";
import {Message} from "./message";
import {Store} from "../data/store";
import {QueueType} from "../data/queuetype";
import {Mode} from "./mode";
import {
  CONTENTFLY_SYNC_START, CONTENTFLY_SYNC_SUCCESS,
  ENTITIES_TO_EXCLUDE,
  SYNC_CHUNK_SIZE, TIMEOUT_SYNC_MINUTES
} from "../constants";
import {Schema} from "../data/schema";
import {SyncState} from "./syncstate";
import {Api} from "../api/api";
import {Logger} from "../helper/logger";
import {File} from "@ionic-native/file";
import {Uploader} from "./uploader";
import {BehaviorSubject} from "rxjs/BehaviorSubject";
import { Observable } from "rxjs/Observable";
import {Events} from "ionic-angular";
import {P} from "@angular/core/src/render3";
import {DependentEntity} from "../data/dependentEntity";


@Injectable()
export class Service {

  private api : Api = null;
  private currentDataCount : number             = 0;
  private currentRetryFrom : number             = 0;
  private currentRetryTo : number               = 0;
  private dataCount : number                    = 0;
  private data : BehaviorSubject<Message>       = null;
  public dependentEntities : DependentEntity[]  = [];
  private imageDownloadSize : string            = null;
  private isSyncing : boolean                   = false;
  public syncChunkSize : number                 = SYNC_CHUNK_SIZE;
  public syncUsedFilesOnly : boolean            = true;

  constructor(private events : Events, private file : File, private logger : Logger, private schema : Schema, private store : Store, private syncState : SyncState, private uploader : Uploader) {

  }

  private checkSyncTimeout(){
    let lastSyncToDate = this.syncState.getLastSyncStartDate();
    this.logger.info('[service.sync]::isSyncing (' + lastSyncToDate +')', this.isSyncing);

    if(lastSyncToDate){
      let currDate = new Date();
      let sec = (currDate.getTime() - lastSyncToDate)/1000;

      if(sec/60 > TIMEOUT_SYNC_MINUTES){
        this.isSyncing = false;
      }
    }else{
      this.isSyncing = false;
    }
  }

  public countFromServer() : Promise<number>{
    let countParams: {} = {};

    //Lade letzte Synchronisations-Datum zu jeder Entität
    for (let entityName in this.schema.data) {
      if (ENTITIES_TO_EXCLUDE.indexOf(entityName) >= 0) continue;
      if (this.syncState.getLastSyncDate(entityName)) {
        countParams[entityName] = this.syncState.getLastSyncDate(entityName);
      }
    }

    let params  = {};

    if (Object.keys(countParams).length) {
      params = {lastModified: countParams};
    }

    return this.api.post('count', params).then((countRequest) => {
      return countRequest['data']['dataCount'];
    })
  }

  /**
   * Gibt den Synchronisations-Prozess zurück
   * @returns {Observable<Message>}
   */
  private getData() {
    return this.data.asObservable();
  }


  /**
    * Gibt die Anzahl der zu synchronisierenden Objekte zurück
    * @return Promise<any[]>
    * */
  private getQueue() : Promise<any[]>{
    let statement = "" +
      "SELECT * " +
      "FROM `queue` " +
      "ORDER BY `entity_id`, `created` ASC";

    return this.store.query(statement, []);
  }

  /**
   * Setzt das API-Projekt, wird benötigt um die Method sync() aufzurufen
   * @param {Api} api
   */
  public setApi(api : Api){
    this.api = api;
  }

  /**
   * Lädt beim Synchronisieren nicht die Original Bilddatei, sondern die entsprechende im Backend definierte Bildgröße
   * @param {string} sizeName
   */
  public setImageDownloadSize(sizeName : string){
    this.imageDownloadSize = sizeName;
  }


  /**
   * Startet den Synchronisations-Projekt
   * @param {boolean} disableSyncFrom Deaktiviert die Synchronisierung vom Server
   * @returns {Observable<Message>}
   */
  public sync(disableSyncFrom : boolean = false){

    this.startSync(disableSyncFrom);

    return this.getData();
  }

  /**
   * Startet den Synchronisations-Projekt vom Server
   * @returns {Observable<Message>}
   */
  public syncFrom(){

    this.startSync(false, true);

    return this.getData();
  }

  /**
   * Startet den Synchronisations-Projekt zum Server
   * @returns {Observable<Message>}
   */
  public syncTo(){

    this.startSync(true, false);

    return this.getData();
  }

  /**
   * Startet die Synchronisation der Dateien
   * @returns {Promise<any[]>}
   */
  private syncFiles() : Promise<boolean>{

    let subqueries             = [];
    let syncUsedFilesOnlyQuery = '';

    if(this.syncUsedFilesOnly) {
      for (let entityName in this.schema.data) {
        if (entityName == '_hash') continue;

        let entityConfig = this.schema.data[entityName];
        let dbName = entityConfig.settings.dbname;
        for (let propertyName in entityConfig.properties) {
          let propertyConfig = entityConfig.properties[propertyName];
          switch (propertyConfig.type) {
            case 'file':
              subqueries.push("SELECT DISTINCT " + propertyConfig.dbfield + " FROM " + dbName);
              break;
            case 'multifile':
              let field = propertyConfig.mappedBy ? propertyConfig.mappedBy + '_id' : 'file_id';
              subqueries.push("SELECT DISTINCT " + field + " FROM " + propertyConfig.foreign);
              break;
          }
        }
      }

      syncUsedFilesOnlyQuery = " AND id IN(" + subqueries.join(' UNION ') + ")";
    }

    let statement = "" +
      "SELECT id, name, hash, _hashLocal, type, size " +
      "FROM pim_file " +
      "WHERE (_hashLocal IS NULL OR hash != _hashLocal) AND type != 'link/youtube'" + syncUsedFilesOnlyQuery;

    return this.store.query(statement, []).then((files) => {
      //Noch nicht synchronisierte Dateien wurden ermittelt

      if(!files.length){
        return Promise.resolve(false);
      }

      this.dataCount        = files.length;
      this.currentDataCount = 0;

      let allPromises = [];

      this.data.next(new Message(Mode.FROM, 'Dateien werden synchronisiert...', 0, 1, this.dataCount, 'synchronisiert'));

      for(let index = 0; index < files.length; index++){

        let file = files[index];

        let size = file['type'] && file['type'].substr(0, 5) == 'image' ? this.imageDownloadSize : null;

        let p = this.api.file(file['id'], size).then((blob) => {
          //Binäre Datei/Blob wurde geladen
          this.logger.info('[sync.service->syncFiles:load] api/file/' + file['id'], 'loaded 1 ');
          let filename : string = (file['id'] as string) + '';
          let type : string     = file['type'];

          if(type && type.substr(0, 5) == 'video'){
            let typeParts = type.split('/');
            filename = filename + '.' + typeParts[1];
          }

          return this.file.writeFile(this.file.dataDirectory, filename, blob, {replace: true} );
        }).then(() => {
          //Blob wurde lokal gespeichert
          let updateData = {
            'id' : file['id'],
            '_hashLocal' : file['hash']
          };

          return this.store.update('PIM\\File', updateData, true, true);
        }).then(() => {
          //Datenbank wurde aktualisiert
          this.currentDataCount++;
          let progress = Math.round(this.currentDataCount / this.dataCount * 100);
          this.data.next(new Message(Mode.FROM, 'Dateien werden synchronisiert...', progress, this.currentDataCount, this.dataCount, 'synchronisiert'));

          return Promise.resolve();
        }).catch((error) => {
          this.logger.error('[sync.service->syncFiles] api/file/' + file['id'], error);
          return Promise.resolve();
        });

        allPromises.push(p);

      }

      return Promise.all(allPromises).then(() => {
        this.logger.info('[sync.service->syncFiles] all loaded');
        return Promise.resolve(true);
      });
    });
  }

  /**
   * Synchronisiert eine Mulijoin-Entity/-Tabelle
   * @param {string} key
   * @param {string} entityName
   * @param {string} entityProperty
   * @param {string} sourceTableName
   * @param {string} sourceJoinField
   * @param {string} destTableName
   * @param {string} lastSyncDate
   * @param {number} startFromChunk
   * @returns {Promise<any>}
   */
  private syncMultijoinFromEntity(key: string, entityName : string, entityProperty : string, sourceTableName : string, sourceJoinField : string, destTableName: string, lastSyncDate : string, startFromChunk : number){

    var from = {};
    from[sourceTableName] = "src";

    sourceJoinField = sourceJoinField.substr(0, 3) == 'pim' ? sourceJoinField.substr(3) : sourceJoinField;

    let params = {
      "select": "src.*",
      "from": from,
      setMaxResults: this.syncChunkSize,
      setFirstResult: this.syncState.getLastChunkSize(key)
    };

    let innerJoin     = [["src", destTableName, "dest", "src." + sourceJoinField + " = dest.id"]];

    if(this.dependentEntities.length){
      for(let dependentEntitiy of this.dependentEntities){
        if(dependentEntitiy.sourceEntity == entityName){

          if(!this.schema.data[dependentEntitiy.destEntity]){
            this.logger.info('Destination-Entity for Dependency not found.', dependentEntitiy);
            continue;
          }

          let sourcePropertyConfig = null;
          let entityConfig         = this.schema.data[entityName];
          if(!(sourcePropertyConfig = entityConfig.properties[dependentEntitiy.sourceProperty])){
            this.logger.info('Source-Property for Dependency not found.', dependentEntitiy);
            continue;
          }

          let prop = dependentEntitiy.sourceProperty + '_id';
          innerJoin.push(['src', entityName, 'dest_org', 'dest_org.id = src.' + entityConfig.settings.dbname + '_id']);
          innerJoin.push(['dest_org', dependentEntitiy.destEntity, 'dest_org_dep', 'dest_org_dep.id = dest_org.' + sourcePropertyConfig.dbfield]);
        }
      }
    }

    params['innerJoin'] = innerJoin;

    if(lastSyncDate){
      params['where'] = {'dest.modified > ?' : [lastSyncDate]};
    }

    return this.api.post('query', params).then((request) => {
      //Datensätze seit letzter Synchronisierung wurden ermittelt
      if(!this.syncState.getStartSyncDate(key)){
        this.syncState.setStartSyncDate(key, request['ts']);
      }

      let data: any[] = request['data'] ? request['data'] : [];

      if (data.length > 0) {
        //Datensätze vorhanden und in Datenbank importieren

        var promise = new Promise((resolve, reject) => {

          this.store.importMultijoin(sourceTableName, data).subscribe(
            () => {
              this.currentDataCount++;
              let progress = Math.round(this.currentDataCount / this.dataCount * 100);

              this.data.next(new Message(Mode.FROM, 'Datensätze werden synchronisiert...', progress, this.currentDataCount, this.dataCount, 'synchronisiert'));
            },
            (error) => {
              this.logger.error('[sync.service->syncFromEntity] store.import', error);
              resolve();
            },
            () => {
              //Datensätze wurden importiert, nächsten Chunk-Durchlauf anstoßen

              let newStartFromChunK = startFromChunk + this.syncChunkSize;
              this.syncState.setLastChunkSize(key, newStartFromChunK);
              this.syncState.save();

              this.syncMultijoinFromEntity(key, entityName, entityProperty, sourceTableName, sourceJoinField, destTableName, lastSyncDate, newStartFromChunK).then(() => {
                resolve();
              })
            }
          );
        });

        //Rückgabe Promise an ->CODE_SYNCFROM_PARALLEL
        return promise;
      } else {
        //Keine Datensätze vorhanden, Synchronisierung der Entität abschließen

        this.syncState.setLastChunkSize(key, 0);
        this.syncState.setLastSyncDate(key, this.syncState.getStartSyncDate(key));
        this.syncState.setStartSyncDate(key, null);
        this.syncState.save();

        //Rückgabe Promise an ->CODE_SYNCFROM_PARALLEL
        return Promise.resolve([]);
      }
    }).catch((error) => {
      this.logger.error('[sync.service->syncMultijoinFromEntity] api/query', error);
      return Promise.resolve([]);
    });
  }

  /**
   * Synchronisiert eine Entität
   * @param {string} entityName
   * @param {string} lastSyncDate
   * @param {number} startFromChunk
   * @returns {Promise<any>}
   */
  private syncFromEntity(entityName : string, lastSyncDate : string, startFromChunk : number){

    var entityConfig = this.schema.data[entityName];
    let dbname       = entityConfig.settings.dbname;

    var from = {};
    from[dbname] = 'src';

    let params : any = {
      select: 'src.*',
      from: from,
      setMaxResults: this.syncChunkSize,
      setFirstResult: this.syncState.getLastChunkSize(entityName)
    };

    if(this.dependentEntities.length){
      for(let dependentEntitiy of this.dependentEntities){
        if(dependentEntitiy.sourceEntity == entityName){

          if(!this.schema.data[dependentEntitiy.destEntity]){
            this.logger.info('Destination-Entity for Dependency not found.', dependentEntitiy);
            continue;
          }

          let sourcePropertyConfig = null;
          if(!(sourcePropertyConfig = entityConfig.properties[dependentEntitiy.sourceProperty])){
            this.logger.info('Source-Property for Dependency not found.', dependentEntitiy);
            continue;
          }

          let prop = dependentEntitiy.sourceProperty + '_id';
          params['innerJoin'] = ['src', dependentEntitiy.destEntity, 'dep_dest', 'dep_dest.id = src.' + sourcePropertyConfig.dbfield];
        }
      }
    }

    var entityConfig = this.schema.data[entityName];
    if(entityConfig['settings']['type'] == 'tree'){
      let joinTableName = entityConfig['settings']['i18n'] ? 'pim_i18n_tree' : 'pim_tree';

      params['select'] += ', j.*';
      params['leftJoin'] = ['src', joinTableName, 'j',  'src.id = j.id'];
    }

    if(lastSyncDate){
      params['where'] = {'src.modified > ?' : [lastSyncDate]};
    }

    return this.api.post('query', params).then((request) => {
      //Datensätze seit letzter Synchronisierung wurden ermittelt
      if(!this.syncState.getStartSyncDate(entityName)){
        this.syncState.setStartSyncDate(entityName, request['ts']);
      }

      let data: any[] = request['data'] ? request['data'] : [];

      if (data.length > 0) {
        //Datensätze vorhanden und in Datenbank importieren

        var promise = new Promise((resolve, reject) => {
          //Todo: Deleted Objects from Entity as Param
          this.store.import(entityName, data).subscribe(
            () => {
              this.currentDataCount++;
              let progress = Math.round(this.currentDataCount / this.dataCount * 100);

              this.data.next(new Message(Mode.FROM, 'Datensätze werden synchronisiert...', progress, this.currentDataCount, this.dataCount, 'synchronisiert'));
            },
            (error) => {
              this.logger.error('[sync.service->syncFromEntity] store.import', error);
              resolve();
            },
            () => {
              //Datensätze wurden importiert, nächsten Chunk-Durchlauf anstoßen
              let newStartFromChunK = startFromChunk + this.syncChunkSize;
              this.logger.info('[sync.service->NEW CHUNK] ' + entityName, newStartFromChunK);
              this.syncState.setLastChunkSize(entityName, newStartFromChunK);
              this.syncState.save();

              this.syncFromEntity(entityName, lastSyncDate, newStartFromChunK).then(() => {
                resolve();
              });
            }
          );
        });

        //Rückgabe Promise an ->CODE_SYNCFROM_PARALLEL
        return promise;

      }else{
        //Keine Datensätze vorhanden, Synchronisierung der Entität abschließen

        this.syncState.setLastChunkSize(entityName, 0);
        this.logger.info('[sync.service->FINISH] ' + entityName, this.syncState.getStartSyncDate(entityName));
        this.syncState.setLastSyncDate(entityName, this.syncState.getStartSyncDate(entityName));
        this.syncState.setStartSyncDate(entityName, null);
        this.syncState.save();

        //Rückgabe Promise an ->CODE_SYNCFROM_PARALLEL
        return Promise.resolve([]);
      }
    }).catch((error) => {
      this.logger.error('[sync.service->syncFromEntity] api/query/' + entityName + '::' + JSON.stringify(params), error);
      return Promise.resolve([]);
    });
  }

  /**
   * Startet den Synchronisations-Prozess
   * @param {boolean} disableSyncFrom Deaktiviert die Synchronisierung vom Server
   */
  private startSync(disableSyncFrom : boolean = false, disableSyncTo : boolean = false){
    this.checkSyncTimeout();

    if(this.isSyncing) return;

    this.events.publish(CONTENTFLY_SYNC_START, null);

    this.isSyncing  = true;
    this.data       = new BehaviorSubject<Message>(new Message(Mode.TO, 'Starte Synchronisierung...'));

    this.syncState.load().then(() => {
      this.syncState.setLastSyncStartDate();
      this.syncState.save();
      let promiseSchema = this.schema && Object.keys(this.schema.data).length > 0 ? Promise.resolve() : this.updateSchema();
      return promiseSchema;
    }).then(() => {
      return disableSyncTo ? this.startSyncFrom() : this.startSyncTo();
    }).then(() => {
      return disableSyncFrom || disableSyncTo ? Promise.resolve() : this.startSyncFrom();
    }).then(() => {

      if(disableSyncFrom){
        this.logger.info('[service.startSyncTo]', 'finished');

        this.data.next(new Message(Mode.FROM, 'Daten wurden erfolgreich synchronisiert.', 0, 0, 0));
        this.events.publish(CONTENTFLY_SYNC_SUCCESS, null);
      }else{
        this.logger.info('[service.startSyncFrom]', 'finished');
      }

      this.isSyncing = false;
      this.data.complete();
    }).catch((error) => {

      this.data.next(new Message(Mode.FROM, 'Synchronisation wurde mit Fehlern abgebrochen.', 0, 0, 0));
      this.logger.error('[service.startSync] ' + this.api.user.token, error);
      this.isSyncing = false;
      this.data.error(error);
    });
  }

  /**
   * Startet Synchronisations-Prozess vom Server
   * @returns {Promise<void>}
   */
  private startSyncFrom(){
    this.data.next(new Message(Mode.FROM, 'Prüfe Änderungen auf dem Server...'));

    let countLoaded : number      = 0;
    let countParams: {}           = {};
    let countRequest : any        = null;
    let entitiesToSync : number   = 1;
    let params                    = {};

    return this.syncState.load().then(() => {

      //Lade letzte Synchronisations-Datum zu jeder Entität
      for (let entityName in this.schema.data) {
        let entityConfig = this.schema.data[entityName];

        if (ENTITIES_TO_EXCLUDE.indexOf(entityName) >= 0 || entityConfig['settings']['excludeFromSync']) continue;
        if (this.syncState.getLastSyncDate(entityName)) {
          countParams[entityName] = this.syncState.getLastSyncDate(entityName);
        }
        entitiesToSync++;
        countLoaded += this.syncState.getLastChunkSize(entityName);
      }

      let startPromise  = null;


      this.logger.info("[service.startSyncFrom]");

      if (Object.keys(countParams).length) {
        params = {lastModified: countParams};
        startPromise = this.api.post('deleted', params);
      }else{
        startPromise = Promise.resolve(null);
      }

      return startPromise;
    }).then((deletedObjectsFromPromise : any) => {
      //Gelöschte Objekte wurden ausgelesen, oder beim Start übersprungen

      if(deletedObjectsFromPromise && deletedObjectsFromPromise.data && deletedObjectsFromPromise.data.length > 0){
        this.logger.info("[service.startSyncFrom] delete", deletedObjectsFromPromise.data.length + ' objects');

        this.data.next(new Message(Mode.FROM, 'Datenbank bereinigen...', 0, 0, 0));
        return this.store.deleteObjects(deletedObjectsFromPromise.data);
      }else{
        return Promise.resolve([])
      }

    }).then(() => {
      //Alte Datensätze wurden gelöscht
      let entitiesSynced : number = 0;

      this.data.next(new Message(Mode.FROM, 'Prüfe Änderungen auf dem Server...', Math.round(entitiesSynced/entitiesToSync*100), entitiesSynced, entitiesToSync, 'geprüft'));

      let countRequestAll = {
        'data' : {
          'dataCount'  : 0,
          'filesCount' : 0,
          'filesSize'  : 0,
        },
        'hash' : null,
        'ts': {}
      };

      let promises  = [];

      for (let entityName in this.schema.data) {
        let entityConfig = this.schema.data[entityName];

        if (ENTITIES_TO_EXCLUDE.indexOf(entityName) >= 0 || entityConfig['settings']['excludeFromSync']) continue;

        params['entity'] = entityName;

        let p = this.api.post('count', params).then((countRequest) => {
          countRequestAll['ts'][entityName]     = countRequest['ts'];
          countRequestAll['data']['dataCount'] += countRequest['data']['dataCount'];
          countRequestAll['hash']               = countRequest['hash'];
          entitiesSynced++;

          this.data.next(new Message(Mode.FROM, 'Prüfe Änderungen auf dem Server...', Math.round(entitiesSynced/entitiesToSync*100), entitiesSynced, entitiesToSync, 'geprüft'));
        });

        promises.push(p);

      }

      params['entity'] = 'PIM\\File';

      let p = this.api.post('count', params).then((countRequest) => {
        countRequestAll['data']['filesCount'] += countRequest['data']['filesCount'];
        countRequestAll['data']['filesSize']  += countRequest['data']['filesSize'];
        countRequestAll['hash']        = countRequest['hash'];
        entitiesSynced++;

        this.data.next(new Message(Mode.FROM, 'Prüfe Änderungen auf dem Server...', Math.round(entitiesSynced/entitiesToSync*100), entitiesSynced, entitiesToSync, 'geprüft'));
      });
      promises.push(p);

      return Promise.all(promises).then(() => {
        return Promise.resolve(countRequestAll);
      })
    }).then((countRequestFromPromise) => {
      //Anzahl der geänderten Datensätze wurde ermittelt, gegebenenfalls wird Update des Schemas durchgeführt
      countRequest = countRequestFromPromise;

      if (countRequest['hash'] != this.schema.hash) {
        //this.data.next(new Message(Mode.FROM, 'Aktualisiere Datenbankschema...'));
        return this.updateSchema();
      } else {
        return Promise.resolve();
      }
    }).then((data) => {
      //Schema-Update wurde durchgeführt, oder nur Anzahl der Datensätze gespeichert
      this.dataCount        = countRequest['data']['dataCount'] - countLoaded;
      this.currentDataCount = 0;

      let entities : any[] = [];
      //Ermittle zu synchronisierende Entitäten
      for (let entityName in this.schema.data) {
        if(ENTITIES_TO_EXCLUDE.indexOf(entityName) >= 0) continue;

        var entityConfig = this.schema.data[entityName];

        if(entityConfig['settings']['excludeFromSync']) continue;

        if(this.schema.permissions[entityName]){
          if(!this.schema.permissions[entityName]['readable']) continue;
        }

        entities.push({key: entityName, entityName: entityName, isMultijoin: false});

        for (let property in entityConfig.properties) {
          var propertyConfig: any = entityConfig.properties[property];
          var type: string = propertyConfig.type;

          switch(type){
            case "multifile":

              var joinedTableName = propertyConfig.foreign ? propertyConfig.foreign :  entityConfig.settings.dbname + "_" + property;

              entities.push({
                key: entityName + '_' + property,
                entityName:entityName,
                entityProperty: property,
                srcTableName: joinedTableName,
                srcJoinField: propertyConfig.mappedBy ? propertyConfig.mappedBy + "_id" : "file_id",
                destTableName: "pim_file",
                isMultijoin: true
              });

              break;
            case "multijoin":
              if(!propertyConfig.foreign){
                continue;
              }

              entities.push({
                key: entityName + '_' + property,
                entityName:entityName,
                entityProperty: property,
                srcTableName: propertyConfig.foreign,
                srcJoinField: entityConfig.settings.dbname.replace('_', '') + "_id",
                destTableName: entityConfig.settings.dbname,
                isMultijoin: true
              });

              continue;
            default:
              break;
          }
        }

      }

      if(this.dataCount == 0){

        if(countRequest['ts']){

          for (let entityName in countRequest['ts']) {
            this.syncState.setLastSyncDate(entityName, countRequest['ts'][entityName]) ;
            this.syncState.setStartSyncDate(entityName, null);
          }

          this.syncState.save();
        }

        return Promise.resolve([]);
      }

      //[CODE_SYNCFROM_PARALLEL] Parallele Synchronisierung der Datensätze pro Entität
      var allPromises = [];

      this.data.next(new Message(Mode.FROM, 'Lade Änderungen vom Server...'));
      this.logger.info("[service.startSyncFrom] import ", this.dataCount + 'objects');
      for (let index in entities) {

        var entity = entities[index];
        var key = entity['key'];
        var entityName = entity['entityName'];
        var isMultijoin = entity['isMultijoin'];

        var lastSyncDate = this.syncState.getLastSyncDate(entityName);

        if (!isMultijoin) {

          let startFromChunK = this.syncState.getLastChunkSize(entityName);
          allPromises.push(this.syncFromEntity(entityName, lastSyncDate, startFromChunK));
        } else {
          let startFromChunK = this.syncState.getLastChunkSize(key);

          allPromises.push(this.syncMultijoinFromEntity(key, entityName, entity['entityProperty'], entity['srcTableName'], entity['srcJoinField'], entity['destTableName'], lastSyncDate, startFromChunK));
        }
      }

      return Promise.all(allPromises);

    }).then(() => {
      //Paralle Synchronisierung der Entitäten abgeschlossen

      return this.syncFiles();

    }).then((filesAreSynced) => {
      //Dateien wurden synchronisiert

      if(filesAreSynced){
        this.data.next(new Message(Mode.FROM, 'Daten wurden erfolgreich synchronisiert.', 0, 0, 0));
        this.events.publish(CONTENTFLY_SYNC_SUCCESS, null);

      }else{
        this.data.next(new Message(Mode.FROM, 'Keine Änderungen auf dem Server vorhanden.', 0, 0, 0));
        this.logger.info("Keine neuen Daten vorhanden.");
      }

      return Promise.resolve();

    });

  }

  /**
   * Startet Synchronisations-Prozess zum Server - Observable Startup Message
   * @returns {Promise<any[]>}
   */
  private startSyncTo() {
    this.logger.info("[service.startSyncTo]", "started");
    this.data.next((new Message(Mode.TO, 'Prüfe lokale Änderungen...')));
    return this.startSyncToProc();
  }

  /**
   * Startet Synchronisations-Prozess zum Server - Prozess
   * @returns {Promise<any[]>}
   */
  private startSyncToProc(){

    this.currentRetryTo++;

    return this.getQueue().then((objects) => {
      //Zu synchronisierende Datensätze wurden ermittelt
      if (!objects || !objects.length ) {
          return Promise.resolve([]);
      }

      let message = 'Übermittle ' + objects.length + ' Datensätze an Server';

      if(this.currentRetryTo > 1){
        message += ' (' + this.currentRetryTo + '. Versuch)';
      }

      this.data.next(new Message(Mode.TO, message));
      //Datensätze aus Queue bereinigen
      // - nur letzte Änderungen eines Objektes
      // - Überspringen und aus Queue löschen, wenn letzte Änderungeb = DEL und das Objekt zur vor eingefügt wurde
      let cleanedObjects: any[] = [];
      let deletedObjects : string[] = [];
      let lastObject: any = null;
      let lastIsInserted: boolean = false;

      this.logger.info("[service.startSyncTo] objects", objects.length);


      for (let object of objects) {
        if (lastObject && lastObject.entity_id != object.entity_id) {
          if (lastObject.mode != QueueType.deleted || lastObject.mode == QueueType.deleted && !lastIsInserted) {
            cleanedObjects.push(lastObject);
          }else{
            deletedObjects.push(lastObject.entity_id);
          }
          lastIsInserted = false;
        }

        lastIsInserted = lastIsInserted || object.mode == QueueType.inserted;
        lastObject = object;
      }

      if (lastObject.mode != QueueType.deleted || lastObject.mode == QueueType.deleted && !lastIsInserted) {
        cleanedObjects.push(lastObject);
      }else{
        deletedObjects.push(lastObject.entity_id);
      }

      let sqlDeleteStatements = [];
      for(let deletedObjectId of deletedObjects){
        sqlDeleteStatements.push(["DELETE FROM queue WHERE entity_id = ?", [deletedObjectId]]);

        for(var cleanedObjectIndex = 0; cleanedObjectIndex <  cleanedObjects.length; cleanedObjectIndex++){
          let cleanedObject = cleanedObjects[cleanedObjectIndex];
          let joins = JSON.parse(cleanedObject.joins);
          if (joins && joins.length > 0) {
            for (let join of joins) {
              if(join.entity_id == deletedObjectId){
                //todo: Optonale Joins ("ON DELETE SET NULL")
                sqlDeleteStatements.push(["DELETE FROM queue WHERE entity_id = ?", [cleanedObject.entity_id]]);
                cleanedObjects.slice(cleanedObjectIndex, 1);
              }
            }
          }
        }
      }

      this.logger.info("[service.startSyncTo] objects cleaned", cleanedObjects.length + ' / ' + deletedObjects.length);

      if(sqlDeleteStatements.length > 0){
        this.store.batch(sqlDeleteStatements).then().catch();
      }

      if(!cleanedObjects.length){
        return Promise.resolve([]);
      }

      //Abhängigkeiten ermitteln und Datensätze mit Joins extrahieren
      let objectsToSync: any[] = [];
      let joinedObjectsToSync: {} = {};
      let allJoinedObjects: number = 0;

      for(let cleanedObject of cleanedObjects){
        let joins = JSON.parse(cleanedObject.joins);
        let joinFound = false;
        if (joins && joins.length > 0) {
          for (let join of joins) {
            if (objects.find(x =>  x.entity_id == join.entity_id && x.mode == QueueType.inserted && x.id != cleanedObject.id)) {
              joinFound = true;

              if (!joinedObjectsToSync[join.entity_id]) {
                joinedObjectsToSync[join.entity_id] = [];
              }
              joinedObjectsToSync[join.entity_id].push(cleanedObject);
              allJoinedObjects++;
            }
          }

          if (!joinFound) {
            objectsToSync.push(cleanedObject);
          }
        } else {
          objectsToSync.push(cleanedObject);
        }
      }

      //Hochladen der Datensätze auf den Sever starten
      this.logger.info("[service.startSyncTo] objectsToSync", objectsToSync.length);
      this.uploader.init(allJoinedObjects + objectsToSync.length, joinedObjectsToSync);


      //return Promise.resolve([]);
      return this.uploader.start(this.api, objectsToSync);
    }).then(() => {
      return this.getQueue();
    }).then((objects) => {
      if(!objects || !objects.length || this.currentRetryTo >= this.api.retry){
        return this.startSyncToEnd();
      }

      return this.startSyncToProc();
    }).catch((error) => {

      this.logger.info('[store.startSyncTo]', error);

      return Promise.reject(error);

    });
  }

  private startSyncToEnd(){
    this.logger.info("[service.startSyncTo]", "finished (" + this.currentRetryTo + ")");

    let d           = new Date();
    let datestring  = d.getFullYear() + '-' + ("0"+(d.getMonth()+1)).slice(-2) + '-' + ("0" + d.getDate()).slice(-2) + ' ' + ("0" + d.getHours()).slice(-2) + ':' + ("0" + d.getMinutes()).slice(-2) + ':' + ("0" + d.getSeconds()).slice(-2)

    this.currentRetryTo = 0;

    this.syncState.setLastSyncToDate(datestring);
    this.syncState.save();
    return Promise.resolve([]);
  }

  /**
   * Führt ein Schema-Update der Datenbank durch
   * @returns {Promise<void>}
   */
  private updateSchema(){

    return this.api.get('schema').then((schema) => {
      this.data.next(new Message(Mode.FROM, 'Datenbank aktualisieren...'));
      this.logger.info("SYNC store.updateSchema START");
      this.schema.update(schema['data'], schema['permissions']);
      return this.store.updateSchema(this.schema);
    }).then( () => {
      this.logger.info("SYNC store.updateSchema END ");
      this.schema.save();
      return Promise.resolve();
    });
  }

}