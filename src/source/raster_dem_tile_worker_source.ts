import {DEMData} from '../data/dem_data';
import {RGBAImage} from '../util/image';
import type {Actor} from '../util/actor';
import type {
    WorkerDEMTileParameters,
    WorkerDEMTileCallback,
    TileParameters
} from './worker_source';
import {isImageBitmap} from '../util/util';

export class RasterDEMTileWorkerSource {
    actor: Actor;
    loaded: {[_: string]: DEMData};
    offscreenCanvas: OffscreenCanvas;
    offscreenCanvasContext: OffscreenCanvasRenderingContext2D;

    constructor() {
        this.loaded = {};
    }

    loadTile(params: WorkerDEMTileParameters, callback: WorkerDEMTileCallback) {
        const {uid, encoding, rawImageData} = params;
        // Main thread will transfer ImageBitmap if offscreen decode with OffscreenCanvas is supported, else it will transfer an already decoded image.
        const imagePixels = isImageBitmap(rawImageData) ? this.getImageData(rawImageData) : rawImageData as RGBAImage;
        const dem = new DEMData(uid, imagePixels, encoding);
        this.loaded = this.loaded || {};
        this.loaded[uid] = dem;
        callback(null, dem);
    }

    getImageData(imgBitmap: ImageBitmap): RGBAImage {
        if (typeof VideoFrame !== 'undefined') {
            const start = performance.now();
            const vf = new VideoFrame(imgBitmap, {timestamp:0});
            try {
                // formats we can handle: BGRX, BGRA, RGBA, RGBX
                const valid = vf.format.startsWith('BGR') || vf.format.startsWith('RGB');
                if (valid) {
                    const swapBR = vf.format.startsWith('BGR');
                    const size = vf.allocationSize();
                    const rawData = new Uint8Array(size);
                    vf.copyTo(rawData);
                    // OffscreenCanvas.getImageData(-1, -1, width+2, height+2) adds a 1px buffer around the edge
                    // so this code is needed to add the 1px buffer explicitly. Also the result may come back in
                    // BRG format so we need to convert to RGB.
                    const data = new Uint8Array((imgBitmap.width + 2) * (imgBitmap.height + 2) * 4);
                    for (let r = 0; r < imgBitmap.height; r++) {
                        data.set(
                            rawData.subarray(r * imgBitmap.width * 4, (r+1) * imgBitmap.width * 4),
                            (r+1) * (imgBitmap.width + 2) * 4 + 4
                        );
                    }
                    if (swapBR) {
                        for (let i = 0; i < data.length; i+=4) {
                            const tmp = data[i];
                            data[i] = data[i + 2];
                            data[i + 2] = tmp;
                        }
                    }
                    console.log(vf.format, performance.now() - start);
                    return new RGBAImage({width: imgBitmap.width + 2, height: imgBitmap.height + 2}, data);
                }
            } finally {
                vf.close();
            }
        }
        const start = performance.now();
        // Lazily initialize OffscreenCanvas
        if (!this.offscreenCanvas || !this.offscreenCanvasContext) {
            // Dem tiles are typically 256x256
            this.offscreenCanvas = new OffscreenCanvas(imgBitmap.width, imgBitmap.height);
            this.offscreenCanvasContext = this.offscreenCanvas.getContext('2d', {willReadFrequently: true});
        }

        this.offscreenCanvas.width = imgBitmap.width;
        this.offscreenCanvas.height = imgBitmap.height;

        this.offscreenCanvasContext.drawImage(imgBitmap, 0, 0, imgBitmap.width, imgBitmap.height);
        // Insert an additional 1px padding around the image to allow backfilling for neighboring data.
        const imgData = this.offscreenCanvasContext.getImageData(-1, -1, imgBitmap.width + 2, imgBitmap.height + 2);
        this.offscreenCanvasContext.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);
        return new RGBAImage({width: imgData.width, height: imgData.height}, imgData.data);
    }

    removeTile(params: TileParameters) {
        const loaded = this.loaded,
            uid = params.uid;
        if (loaded && loaded[uid]) {
            delete loaded[uid];
        }
    }
}
