import {Event, ErrorEvent, Evented} from '../util/evented';

import {extend} from '../util/util';

import type {Source} from './source';
import type {Map} from '../ui/map';
import type {Dispatcher} from '../util/dispatcher';
import {Tile} from './tile';
import {StyleExpression, createExpression, type ContourSourceSpecification, type PromoteIdSpecification} from '@maplibre/maplibre-gl-style-spec';
import {MessageType} from '../util/actor_messages';
import {WorkerTileParameters, WorkerTileResult} from './worker_source';
import {TileBounds} from './tile_bounds';
import {RasterDEMTileSource} from './raster_dem_tile_source';

export type ContourSourceOptions = ContourSourceSpecification & {
    collectResourceTiming?: boolean;
}

export type ContourSourceInternalOptions = {
}

export class ContourTileSource extends Evented implements Source {
    type: 'contour';
    id: string;
    minzoom: number;
    maxzoom: number;
    overzoom: number;
    url: string;
    tileSize: number;
    promoteId: PromoteIdSpecification;

    _options: ContourSourceSpecification;
    _collectResourceTiming: boolean;
    dispatcher: Dispatcher;
    map: Map;
    bounds: [number, number, number, number];
    tiles: Array<string>;
    reparseOverscaled: boolean;
    isTileClipped: boolean;
    _loaded: boolean;
    _demSource: RasterDEMTileSource;
    tileBounds: TileBounds;
    intervals: StyleExpression;
    majorMultiplier: StyleExpression;
    unit: number;

    constructor(id: string, options: ContourSourceOptions, dispatcher: Dispatcher, eventedParent: Evented) {
        super();
        this.id = id;
        this.dispatcher = dispatcher;

        this.type = 'contour';
        this.minzoom = 0;
        this.maxzoom = 22;
        this.tileSize = 512;
        this.overzoom = typeof options.overzoom === 'number' ? options.overzoom : 1;
        this.reparseOverscaled = true;
        this.isTileClipped = true;
        this._loaded = false;
        this.intervals = compileExpression(options.intervals || 100, 'number');
        this.majorMultiplier = compileExpression(options.majorMultiplier || 5, 'number');
        const unit = options.unit || 'meters';
        if (unit === 'meters') {
            this.unit = 1;
        } else if (unit === 'feet') {
            this.unit = 1 / 0.3048;
        } else if (typeof unit === 'number') {
            this.unit = unit;
        } else {
            throw new Error(`Invalid contour source unit, expected ['meters', 'feet', number], got: ${unit}`);
        }

        // extend(this, pick(options, ['url', 'scheme', 'tileSize', 'promoteId']));
        this._options = extend({type: 'contour'}, options);

        this._collectResourceTiming = options.collectResourceTiming;

        if (this.tileSize !== 512) {
            throw new Error('contour tile sources must have a tileSize of 512');
        }

        this.setEventedParent(eventedParent);
    }

    async load() {
        console.log('ContourTileSource.load()');
        const demSourceCache = this.map.style.sourceCaches[this._options.source];
        const demSource = this._demSource = demSourceCache.getSource() as RasterDEMTileSource;
        this._loaded = false;
        this.fire(new Event('dataloading', {dataType: 'source'}));
        try {
            if (!demSource._loaded) {
                await demSource.once('data');
                // TODO what about error?
            } else {
                // TODO does this need to delay a frame?
            }
            if (!demSource._loaded) {
                throw new Error('DEM source failed to load');
            }
            this._loaded = true;
            this.minzoom = Math.max(this.minzoom, demSource.minzoom);
            this.tileBounds = demSource.tileBounds;
            this.map.style.sourceCaches[this.id].clearTiles();
            console.log('ContourTileSource.loaded!!');
            this.fire(new Event('data', {dataType: 'source', sourceDataType: 'metadata'}));
            this.fire(new Event('data', {dataType: 'source', sourceDataType: 'content'}));
        } catch (err) {
            this.fire(new ErrorEvent(err));
        }
    }

    async loadTile(tile: Tile): Promise<void> {
        console.log('ContourTileSource.loadTile(', tile, ')');
        let messageType: MessageType.loadTile | MessageType.reloadTile = MessageType.reloadTile;
        if (!tile.actor || tile.state === 'expired') {
            tile.actor = this.dispatcher.getActor();
            messageType = MessageType.loadTile;
        } else if (tile.state === 'loading') {
            return new Promise<void>((resolve, reject) => {
                tile.reloadPromise = {resolve, reject};
            });
        }

        const demSource = this._demSource;
        const zoom = Math.min(demSource.maxzoom, this.maxzoom, tile.tileID.canonical.z - this.overzoom);
        const demId = tile.tileID.scaledTo(zoom);
        const abortController = new AbortController();
        tile.abortController = abortController;
        const demTile = new Tile(demId, demSource.tileSize);
        demTile.abortController = tile.abortController;
        try {
            await demSource.loadTile(demTile);
            if (tile.aborted) return;

            const params: WorkerTileParameters = {
                uid: tile.uid,
                tileID: tile.tileID,
                zoom: tile.tileID.overscaledZ,
                tileSize: this.tileSize * tile.tileID.overscaleFactor(), // TODO multiply by overscaleFactor?
                type: this.type,
                source: this.id,
                pixelRatio: this.map.getPixelRatio(),
                showCollisionBoxes: this.map.showCollisionBoxes,
                promoteId: this.promoteId,
                contourOptions: {
                    dem: demTile.dem,
                    demTileID: demId.canonical,
                    unit: this.unit,
                    interval: this.intervals.evaluate({zoom: tile.tileID.canonical.z}),
                    majorMultiplier: this.majorMultiplier.evaluate({zoom: tile.tileID.canonical.z})
                }
            };
            const data = await tile.actor.sendAsync({type: messageType, data: params}, abortController);
            console.log('loaded', data);
            delete tile.abortController;

            // TODO why arent symbols loading?

            if (!tile.aborted) {
                tile.loadVectorData(data, this.map.painter, messageType ===  MessageType.reloadTile);
                if (tile.reloadPromise) {
                    const reloadPromise = tile.reloadPromise;
                    tile.reloadPromise = null;
                    this.loadTile(tile).then(reloadPromise.resolve).catch(reloadPromise.reject);
                }
            }
        } catch (e) {
            console.error(e);
            delete tile.abortController;
            if (!tile.aborted) {
                tile.loadVectorData(null, this.map.painter, messageType ===  MessageType.reloadTile);
                if (tile.reloadPromise) {
                    const reloadPromise = tile.reloadPromise;
                    tile.reloadPromise = null;
                    this.loadTile(tile).then(reloadPromise.resolve).catch(reloadPromise.reject);
                }
            }
        }

        // // TODO should this:
        // // - request DEM tile?
        // // - wait for DEM tile to become available?
        // // - only return synchronously and depend on external events to trigger contour tile source reloads?
        // //   ie. if border pixels are added

        // // then: send DEM tile to worker for isoline generation
        // // tile.state = ''
        // console.log(demSourceCache._tiles[tile.tileID.key]);

        // return null;

        // // console.log(demTile);

        // const url = tile.tileID.canonical.url(this.tiles, this.map.getPixelRatio(), 'xyz');
        // const params = {
        //     request: this.map._requestManager.transformRequest(url, ResourceType.Tile),
        //     uid: tile.uid,
        //     tileID: tile.tileID,
        //     zoom: tile.tileID.overscaledZ,
        //     tileSize: this.tileSize * tile.tileID.overscaleFactor(),
        //     type: this.type,
        //     source: this.id,
        //     pixelRatio: this.map.getPixelRatio(),
        //     showCollisionBoxes: this.map.showCollisionBoxes,
        //     promoteId: this.promoteId
        // };
        // // params.request.collectResourceTiming = this._collectResourceTiming;
        // let messageType: MessageType.loadTile | MessageType.reloadTile = MessageType.reloadTile;
        // if (!tile.actor || tile.state === 'expired') {
        //     tile.actor = this.dispatcher.getActor();
        //     messageType = MessageType.loadTile;
        // } else if (tile.state === 'loading') {
        //     return new Promise<void>((resolve, reject) => {
        //         tile.reloadPromise = {resolve, reject};
        //     });
        // }
        // tile.abortController = new AbortController();
        // try {
        //     const data = await tile.actor.sendAsync({type: messageType, data: params}, tile.abortController);
        //     delete tile.abortController;

        //     if (tile.aborted) {
        //         return;
        //     }
        //     this._afterTileLoadWorkerResponse(tile, data);
        // } catch (err) {
        //     delete tile.abortController;

        //     if (tile.aborted) {
        //         return;
        //     }
        //     if (err && err.status !== 404) {
        //         throw err;
        //     }
        //     this._afterTileLoadWorkerResponse(tile, null);
        // }
    }

    // TODO all boilerplate? extract to common base class?

    loaded(): boolean {
        return this._loaded;
    }

    onAdd(map: Map) {
        this.map = map;
        this.load();
    }

    serialize(): ContourSourceSpecification {
        return extend({}, this._options);
    }

    private _afterTileLoadWorkerResponse(tile: Tile, data: WorkerTileResult) {
        if (data && data.resourceTiming) {
            tile.resourceTiming = data.resourceTiming;
        }

        if (data && this.map._refreshExpiredTiles) {
            tile.setExpiryData(data);
        }
        tile.loadVectorData(data, this.map.painter);

        if (tile.reloadPromise) {
            const reloadPromise = tile.reloadPromise;
            tile.reloadPromise = null;
            this.loadTile(tile).then(reloadPromise.resolve).catch(reloadPromise.reject);
        }
    }

    async abortTile(tile: Tile): Promise<void> {
        console.log('ContourTileSource.abortTile(', tile, ')');
        if (tile.abortController) {
            tile.abortController.abort();
            delete tile.abortController;
        }
        if (tile.actor) {
            await tile.actor.sendAsync({
                type: MessageType.abortTile,
                data: {uid: tile.uid, type: this.type, source: this.id}
            });
        }
    }

    async unloadTile(tile: Tile): Promise<void> {
        console.log('ContourTileSource.unloadTile(', tile, ')');
        tile.unloadVectorData();
        if (tile.actor) {
            await tile.actor.sendAsync({
                type: MessageType.removeTile,
                data: {
                    uid: tile.uid,
                    type: this.type,
                    source: this.id}
            });
        }
    }

    hasTransition() {
        return false;
    }
}

function compileExpression(expression: any, type: string) {
    const compiled = createExpression(expression, {type, 'property-type': 'data-driven', overridable: false, transition: false} as any);
    if (compiled.result === 'error') {
        throw new Error(compiled.value.map(err => `${err.key}: ${err.message}`).join(', '));
    }
    return compiled.value;
}
