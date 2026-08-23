// Umbrales del sistema de monitoreo continuo de sincronizacion (ver README,
// "Sincronizacion continua"). Compartidos entre el loop de correccion
// (useAppController) y el indicador visual, para que el indicador muestre
// exactamente la misma zona que decide la logica de correccion.

/** Por debajo de esto no se hace nada: no se percibe y corregir seria ruido. */
export const UMBRAL_SUAVE_MS = 15

/** Por encima de esto, una correccion suave ya seria audible: se hace un resync duro. */
export const UMBRAL_DURO_MS = 150

/** Cada cuanto se mide el drift mientras se esta reproduciendo. */
export const INTERVALO_MONITOREO_MS = 4000

/** Margen para un resync duro: es autocorreccion de UN dispositivo, no hace falta coordinar con otros. */
export const MARGEN_RESYNC_DURO_MS = 400
