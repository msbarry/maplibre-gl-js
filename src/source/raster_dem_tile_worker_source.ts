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
                const size = vf.allocationSize();
                const rawData = new Uint8Array(size);
                vf.copyTo(rawData);
                console.log('get raw pixels took', performance.now() - start);
                // OffscreenCanvas.getImageData(-1, -1, width+2, height+2) adds a 1px buffer around the edge
                // so this code is needed to add the 1px buffer explicitly. Also the result may come back in
                // BRG format so we need to convert to RGB.
                // getting the raw pixels takes 0-2ms, but changing this format takes 10-20ms
                const data = new Uint8Array((imgBitmap.width + 2) * (imgBitmap.height + 2) * 4);
                switch (vf.format) {
                    case 'BGRA':
                    case 'BGRX':
                        for (let r = 0; r < imgBitmap.height; r++) {
                            const inRowStart = r * imgBitmap.width * 4;
                            const outRowStart = (r + 1) * (imgBitmap.width + 2) * 4;
                            let inPixelStart = inRowStart;
                            let outPixelStart = outRowStart + 4;
                            for (let c = 0; c < imgBitmap.width; c++) {
                                data[outPixelStart] = rawData[inPixelStart + 2];
                                data[outPixelStart + 1] = rawData[inPixelStart + 1];
                                data[outPixelStart + 2] = rawData[inPixelStart];
                                outPixelStart += 4;
                                inPixelStart += 4;
                            }
                        }
                        console.log('BRG', performance.now() - start);
                        return new RGBAImage({width: imgBitmap.width + 2, height: imgBitmap.height + 2}, data);
                    case 'RGBA':
                    case 'RGBX':
                        for (let r = 0; r < imgBitmap.height; r++) {
                            const inRowStart = r * imgBitmap.width * 4;
                            const outRowStart = (r + 1) * (imgBitmap.width + 2) * 4;
                            let inPixelStart = inRowStart;
                            let outPixelStart = outRowStart + 4;
                            for (let c = 0; c < imgBitmap.width; c++) {
                                data[outPixelStart] = rawData[inPixelStart];
                                data[outPixelStart + 1] = rawData[inPixelStart + 1];
                                data[outPixelStart + 2] = rawData[inPixelStart + 2];
                                outPixelStart += 4;
                                inPixelStart += 4;
                            }
                        }
                        console.log('RGB', performance.now() - start);
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
