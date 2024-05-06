import vtpbf from 'vt-pbf';
import {VectorTileWorkerSource} from './vector_tile_worker_source';

import type {
    WorkerTileParameters,
    WorkerTileResult,
} from '../source/worker_source';

import type {LoadVectorTileResult} from './vector_tile_worker_source';
import generateIsolines from './contour_lines';
import {ContourLineWrapper} from './contour_line_wrapper';
import type {RemoveSourceParams} from '../util/actor_messages';
import type {DEMData} from '../data/dem_data';
import type {CanonicalTileID} from './tile_id';
import {HeightTile} from './contour_height_tile';

export type ContourTileWorkerOptions = {
    dem: DEMData;
    demTileID: CanonicalTileID;
    interval: number;
    unit: number;
    majorMultiplier: number;
}

/**
 * The {@link WorkerSource} implementation that supports {@link GeoJSONSource}.
 * This class is designed to be easily reused to support custom source types
 * for data formats that can be parsed/converted into an in-memory GeoJSON
 * representation. To do so, create it with
 * `new GeoJSONWorkerSource(actor, layerIndex, customLoadGeoJSONFunction)`.
 * For a full example, see [mapbox-gl-topojson](https://github.com/developmentseed/mapbox-gl-topojson).
 */
export class ContourTileWorkerSource extends VectorTileWorkerSource {
    _pendingRequest: AbortController;

    override async loadVectorTile(params: WorkerTileParameters, _abortController: AbortController): Promise<LoadVectorTileResult | null> {
        console.log('ContourTileWorkerSource.loadVectorTile(', params, ')');
        const canonical = params.tileID.canonical;
        const options = params.contourOptions;
        const subZ = canonical.z - options.demTileID.z;
        const div = 1 << subZ;
        const start = Date.now();
        // TODO how to do sub-pixel divide?
        let virtualTile = HeightTile.fromRawDem(options.dem)
            .split(subZ, canonical.x % div, canonical.y % div);
        if (virtualTile.width >= 200) {
            virtualTile = virtualTile.materialize(2);
        } else {
            while (virtualTile.width < 200) {
                virtualTile = virtualTile.subsamplePixelCenters(2).materialize(2);
            }
        }

        virtualTile = virtualTile
            .averagePixelCentersToGrid()
            .scaleElevation(1 / options.unit)
            .materialize(1);

        const mid = Date.now();

        const isolines = generateIsolines(options.interval, virtualTile);
        const vectorTile = new ContourLineWrapper(isolines, options);
        console.log('isolines', mid - start, Date.now() - mid);
        // Encode the geojson-vt tile into binary vector tile form.  This
        // is a convenience that allows `FeatureIndex` to operate the same way
        // across different vector tile sources.
        let pbf = vtpbf(vectorTile);
        if (pbf.byteOffset !== 0 || pbf.byteLength !== pbf.buffer.byteLength) {
            pbf = new Uint8Array(pbf);
        }

        return {
            vectorTile,
            rawData: pbf.buffer
        };
    }

    /**
    * Implements {@link WorkerSource#reloadTile}.
    *
    * If the tile is loaded, uses the implementation in VectorTileWorkerSource.
    * Otherwise, such as after a setData() call, we load the tile fresh.
    *
    * @param params - the parameters
    * @returns A promise that resolves when the tile is reloaded
    */
    reloadTile(params: WorkerTileParameters): Promise<WorkerTileResult> {
        const loaded = this.loaded,
            uid = params.uid;

        if (loaded && loaded[uid]) {
            return super.reloadTile(params);
        } else {
            return this.loadTile(params);
        }
    }

    async removeSource(_params: RemoveSourceParams): Promise<void> {
        if (this._pendingRequest) {
            this._pendingRequest.abort();
        }
    }
}
