
import Point from '@mapbox/point-geometry';

import mvt from '@mapbox/vector-tile';
import type {VectorTileFeature, VectorTileLayer, VectorTile} from '@mapbox/vector-tile';
const toGeoJSON = mvt.VectorTileFeature.prototype.toGeoJSON;
import {EXTENT} from '../data/extent';
import type {ContourTileWorkerOptions} from './contour_tile_worker_source';

class FeatureWrapper implements VectorTileFeature {
    _geom: number[][];
    extent: number;
    type: VectorTileFeature['type'];
    id: number;
    properties: {[_: string]: string | number | boolean};

    constructor(feature: [string, number[][]], options: ContourTileWorkerOptions) {
        const ele = this.id = parseInt(feature[0]);
        this._geom = feature[1];
        this.extent = EXTENT;
        this.type = 2;
        const major = (ele / options.interval) % options.majorMultiplier === 0;
        this.properties = {ele, major};
    }

    loadGeometry() {
        const geometry = [];
        for (const ring of this._geom) {
            const newRing = [];
            for (let i = 0; i < ring.length; i += 2) {
                newRing.push(new Point(ring[i], ring[i + 1]));
            }
            geometry.push(newRing);
        }
        return geometry;
    }

    toGeoJSON(x: number, y: number, z: number) {
        return toGeoJSON.call(this, x, y, z);
    }
}

export class ContourLineWrapper implements VectorTile, VectorTileLayer {
    layers: {[_: string]: VectorTileLayer};
    name: string;
    extent: number;
    length: number;
    _features: [string, number[][]][];
    options: ContourTileWorkerOptions;

    constructor(features: { [ele: number]: number[][] }, options: ContourTileWorkerOptions) {
        this.layers = {'_geojsonTileLayer': this};
        this.name = '_geojsonTileLayer';
        this.extent = EXTENT;
        this._features = Object.entries(features);
        this.length = this._features.length;
        this.options = options;
    }

    feature(i: number): VectorTileFeature {
        return new FeatureWrapper(this._features[i], this.options);
    }
}
