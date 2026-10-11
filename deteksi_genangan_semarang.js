// ============================================================
// DETEKSI GENANGAN KOTA SEMARANG - SENTINEL-1 (OKT-NOV 2025)
// Ratio image change detection + Otsu + mask GSW & lereng (DEMNAS)
// Orbit per kejadian, diagnostik tutupan lahan, luas per kecamatan
// Dijalankan di Google Earth Engine Code Editor
// ============================================================

// 1. DAERAH KAJIAN --------------------------------------------
// Ganti path asset sesuai akun GEE kamu (lihat data/README.md)
var kec = ee.FeatureCollection('projects/ee-briliant2709/assets/KecamatanSemarang');
print('Jumlah kecamatan', kec.size());
print('Contoh atribut (cek nama kolom)', kec.first());

var aoiGeom = kec.geometry().dissolve(10);
var aoi = ee.FeatureCollection([ee.Feature(aoiGeom, {name: 'Kota Semarang'})]);
Map.centerObject(aoi, 11);
Map.addLayer(aoi.style({color: 'red', fillColor: '00000000'}), {}, 'Kota Semarang');

// 2. PARAMETER -----------------------------------------------
var beforeRange = ['2025-10-08', '2025-10-21'];   // sebelum banjir (akhir eksklusif)

// rel = nomor relative orbit. Isi angka setelah membaca histogram orbit di Console.
// null = semua orbit (hati-hati: bisa mencampur sudut datang berbeda)
var events = {
  'Banjir_21-27Okt': {range: ['2025-10-21', '2025-10-28'], rel: null},
  'Surut_2-8Nov':    {range: ['2025-11-02', '2025-11-09'], rel: null}   // hapus kalau tidak perlu
};

var orbitPass = 'ASCENDING';
var smoothingRadius = 30;       // meter, speckle filter (focal median)

var absThr = -15;               // dB, syarat piksel "gelap seperti air" pada citra saat banjir
var useDark = true;             // false = klasifikasi murni dari ratio (tanpa syarat VV < absThr)
var useManualThreshold = false; // true = pakai manualThreshold, bukan Otsu
var manualThreshold = -3;       // dB
var maxSlope = 5;               // derajat
var gswThr = 90;                // % occurrence GSW yang dianggap air permanen
var minPatch = 10;              // piksel, buang noise yang lebih kecil dari ini

// 3. DEM (DEMNAS) UNTUK MASK LERENG -----------------------------
var useDEMNAS = true;           // false = pakai SRTM saja
var srtm = ee.Image('USGS/SRTMGL1_003').rename('elev');
var demNas = ee.Image('projects/ee-briliant2709/assets/DEMNAS_Semarang');
print('Band DEMNAS', demNas.bandNames());
var dem = useDEMNAS
  ? demNas.select(0).rename('elev').unmask(srtm)   // celah/NoData DEMNAS diisi SRTM
  : srtm;
var slope = ee.Terrain.slope(dem);
Map.addLayer(slope.gte(maxSlope).selfMask().clip(aoiGeom), {palette: ['FF00FF']},
             'Area ter-mask lereng', false);

// 4. GLOBAL SURFACE WATER: AIR PERMANEN -----------------------
var gsw = ee.Image('JRC/GSW1_4/GlobalSurfaceWater');
var permWater = gsw.select('occurrence').unmask(0).gt(gswThr);
Map.addLayer(permWater.selfMask().clip(aoiGeom), {palette: ['00BFFF']}, 'GSW air permanen', false);

var landMask = permWater.not().and(slope.lt(maxSlope));

// 5. TUTUPAN LAHAN REFERENSI (diagnostik) ----------------------
// ESA WorldCover v200 = kondisi 2021, hanya perkiraan kasar untuk 2025
var wc = ee.Image('ESA/WorldCover/v200/2021').select('Map').clip(aoiGeom);
Map.addLayer(wc, {}, 'ESA WorldCover 2021', false);

// 6. FILTERING CITRA SENTINEL-1 --------------------------------
// S1_GRD di GEE sudah: apply orbit file, border & thermal noise removal,
// kalibrasi radiometrik, terrain correction, konversi dB.
// Filtering = VV, IW, orbit ascending, resolusi 10 m, speckle filter.
var s1 = ee.ImageCollection('COPERNICUS/S1_GRD')
  .filterBounds(aoiGeom)
  .filter(ee.Filter.eq('instrumentMode', 'IW'))
  .filter(ee.Filter.eq('orbitProperties_pass', orbitPass))
  .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
  .filter(ee.Filter.eq('resolution_meters', 10));

// Daftar akuisisi
print('Daftar akuisisi S1 (1 Okt - 15 Nov 2025)',
  s1.filterDate('2025-10-01', '2025-11-16').map(function(i) {
    return ee.Feature(null, {
      tanggal: ee.Date(i.get('system:time_start')).format('YYYY-MM-dd HH:mm'),
      relOrbit: i.get('relativeOrbitNumber_start'),
      pass: i.get('orbitProperties_pass')
    });
  }));

// Diagnostik: jumlah citra per relative orbit di tiap periode.
// Pilih rel yang MUNCUL di periode sebelum DAN periode kejadian yang bersangkutan.
print('Orbit periode SEBELUM',
  s1.filterDate(beforeRange[0], beforeRange[1]).aggregate_histogram('relativeOrbitNumber_start'));
Object.keys(events).forEach(function(n) {
  print('Orbit periode ' + n,
    s1.filterDate(events[n].range[0], events[n].range[1]).aggregate_histogram('relativeOrbitNumber_start'));
});

// Speckle filter dijalankan SEBELUM clip agar tepi AOI tidak terdistorsi
function despeckle(img) {
  return img.focal_median(smoothingRadius, 'circle', 'meters');
}

// 7. FUNGSI BANTU ---------------------------------------------
function otsu(histogram) {
  var counts = ee.Array(ee.Dictionary(histogram).get('histogram'));
  var means = ee.Array(ee.Dictionary(histogram).get('bucketMeans'));
  var size = means.length().get([0]);
  var total = counts.reduce(ee.Reducer.sum(), [0]).get([0]);
  var sum = means.multiply(counts).reduce(ee.Reducer.sum(), [0]).get([0]);
  var mean = sum.divide(total);
  var indices = ee.List.sequence(1, size);
  var bss = indices.map(function(i) {
    var aCounts = counts.slice(0, 0, i);
    var aCount = aCounts.reduce(ee.Reducer.sum(), [0]).get([0]);
    var aMeans = means.slice(0, 0, i);
    var aMean = aMeans.multiply(aCounts).reduce(ee.Reducer.sum(), [0]).get([0]).divide(aCount);
    var bCount = total.subtract(aCount);
    var bMean = sum.subtract(aCount.multiply(aMean)).divide(bCount);
    return aCount.multiply(aMean.subtract(mean).pow(2)).add(
           bCount.multiply(bMean.subtract(mean).pow(2)));
  });
  return means.sort(bss).get([-1]);
}

function areaHa(img) {
  return ee.Number(img.unmask(0).multiply(ee.Image.pixelArea()).divide(10000)
    .reduceRegion({
      reducer: ee.Reducer.sum(), geometry: aoiGeom,
      scale: 10, maxPixels: 1e10, tileScale: 4
    }).get('flood'));
}

// 8. CHANGE DETECTION PER KEJADIAN ----------------------------
var rows = [];

Object.keys(events).forEach(function(name) {
  var ev = events[name];

  // Citra sebelum & saat kejadian diambil dari relative orbit yang sama
  var base = (ev.rel === null)
    ? s1
    : s1.filter(ee.Filter.eq('relativeOrbitNumber_start', ev.rel));
  var beforeCol = base.filterDate(beforeRange[0], beforeRange[1]).select('VV');
  var col = base.filterDate(ev.range[0], ev.range[1]).select('VV');
  print(name + ' | jumlah citra SEBELUM / SAAT (0 = perlebar tanggal atau ganti rel)',
        beforeCol.size(), col.size());

  var before = despeckle(beforeCol.median()).clip(aoiGeom);
  var after  = despeckle(col.median()).clip(aoiGeom);
  Map.addLayer(before, {min: -25, max: 0}, 'VV sebelum (' + name + ')', false);
  Map.addLayer(after, {min: -25, max: 0}, 'VV ' + name, false);

  // Ratio image: dalam dB, rasio linear after/before = selisih (after - before)
  var diff = after.subtract(before).rename('diff');
  Map.addLayer(diff, {min: -8, max: 4, palette: ['0000FF', 'FFFFFF', 'FF0000']},
               'Ratio (dB) ' + name, false);

  // Piksel gelap saat banjir
  var dark = after.lt(absThr);

  // Threshold optimum (Otsu) dihitung HANYA pada piksel gelap di darat
  // (laut/air permanen/lereng dikeluarkan)
  var hist = diff.updateMask(dark.and(landMask)).reduceRegion({
    reducer: ee.Reducer.histogram(255, 0.1),
    geometry: aoiGeom, scale: 10,
    maxPixels: 1e10, bestEffort: true, tileScale: 4
  });
  var thrRaw = ee.Number(otsu(hist.get('diff')));
  var thr = useManualThreshold ? ee.Number(manualThreshold) : thrRaw.max(-6).min(-3);
  print(name + ' | threshold Otsu mentah / terpakai (dB)', thrRaw, thr);

  // Klasifikasi banjir
  var floodRaw = (useDark ? diff.lt(thr).and(dark) : diff.lt(thr)).rename('flood');

  // Masking: air permanen + lereng curam, lalu buang noise kecil
  var flood = floodRaw.and(landMask).selfMask().rename('flood');
  flood = flood.updateMask(flood.connectedPixelCount(100, true).gte(minPatch));

  Map.addLayer(floodRaw.selfMask(), {palette: ['FFA500']}, 'Sebelum mask GSW ' + name, false);
  Map.addLayer(flood, {palette: ['0000FF']}, 'Genangan ' + name);

  // Luas & elevasi rata-rata genangan
  var aRaw = areaHa(floodRaw.selfMask());
  var aFlood = areaHa(flood);
  var elev = dem.updateMask(flood).reduceRegion({
    reducer: ee.Reducer.mean(), geometry: aoiGeom,
    scale: 30, maxPixels: 1e10, bestEffort: true
  }).get('elev');
  print(name + ' | luas sebelum mask (ha)', aRaw);
  print(name + ' | luas genangan final (ha)', aFlood);
  print(name + ' | elevasi rata-rata genangan (m)', elev);

  // Diagnostik: genangan jatuh di tutupan lahan apa (ha)
  var byLC = ee.Image.pixelArea().divide(10000).addBands(wc).updateMask(flood)
    .reduceRegion({
      reducer: ee.Reducer.sum().group({groupField: 1, groupName: 'lc'}),
      geometry: aoiGeom, scale: 10, maxPixels: 1e10, tileScale: 4
    });
  print(name + ' | genangan per tutupan lahan (ha). 10=pohon, 20=semak, 30=rumput, ' +
        '40=sawah/crop, 50=terbangun, 60=lahan terbuka, 80=air, 90=lahan basah, 95=mangrove', byLC);

  // Luas genangan per kecamatan (ha); kolom hasil bernama 'sum'
  var areaImg = flood.unmask(0).multiply(ee.Image.pixelArea()).divide(10000).rename('flood_ha');
  var perKec = areaImg.reduceRegions({
    collection: kec, reducer: ee.Reducer.sum(), scale: 10, tileScale: 4
  }).map(function(f) { return f.set('kejadian', name).setGeometry(null); });
  print(name + ' | luas genangan per kecamatan (kolom sum = ha)', perKec);

  Export.table.toDrive({
    collection: perKec, description: 'Genangan_per_Kecamatan_' + name, fileFormat: 'CSV'
  });

  rows.push(ee.Feature(null, {
    kejadian: name, threshold_dB: thr,
    luas_sebelum_mask_ha: aRaw, luas_genangan_ha: aFlood, elev_rata2_m: elev
  }));

  Export.image.toDrive({
    image: flood.unmask(0).byte(), description: 'Genangan_' + name,
    scale: 10, region: aoiGeom, maxPixels: 1e10
  });
});

Export.table.toDrive({
  collection: ee.FeatureCollection(rows),
  description: 'Luas_Genangan_Semarang', fileFormat: 'CSV'
});
