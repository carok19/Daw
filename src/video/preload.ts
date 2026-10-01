import { contextBridge, ipcRenderer } from 'electron'
import type { ApiVideo } from './tipos'

const api: ApiVideo = {
  estado: () => ipcRenderer.invoke('estado'),
  onEstado: (cb) => void ipcRenderer.on('estado', (_e, v) => cb(v)),
  canciones: () => ipcRenderer.invoke('canciones'),
  elegirArchivos: () => ipcRenderer.invoke('elegir-archivos'),
  agregarVideo: (ruta, proyectoId, cancion) => ipcRenderer.invoke('agregar-video', ruta, proyectoId, cancion),
  copiarSuelto: (ruta) => ipcRenderer.invoke('copiar-suelto', ruta),
  borrarSuelto: (archivo) => ipcRenderer.invoke('borrar-suelto', archivo),
  quitarVideo: (proyectoId) => ipcRenderer.invoke('quitar-video', proyectoId),
  elegirCarpeta: () => ipcRenderer.invoke('elegir-carpeta'),
  confirmarCarpeta: () => ipcRenderer.send('confirmar-carpeta'),
  abrirCarpeta: () => ipcRenderer.send('abrir-carpeta'),
  actualizarVideo: (proyectoId, cambio) => ipcRenderer.invoke('actualizar-video', proyectoId, cambio),
  huellaCancion: (proyectoId) => ipcRenderer.invoke('huella-cancion', proyectoId),
  leerHuellaVideo: (proyectoId) => ipcRenderer.invoke('leer-huella-video', proyectoId),
  guardarHuellaVideo: (proyectoId, huella) => ipcRenderer.invoke('guardar-huella-video', proyectoId, huella),
  usarCodigo: (codigo) => ipcRenderer.send('usar-codigo', codigo),
  usarDireccion: (direccion) => ipcRenderer.send('usar-direccion', direccion),
  elegirPantalla: (id) => ipcRenderer.send('elegir-pantalla', id),
  probarPantalla: () => ipcRenderer.send('probar-pantalla'),
  inicioConWindows: (activo) => ipcRenderer.send('inicio-windows', activo),
  urlDeVideo: (archivo) => `atv://app/videos/${encodeURIComponent(archivo)}`,
  onReproduccion: (cb) => void ipcRenderer.on('reproduccion', (_e, r) => cb(r)),
  onPrueba: (cb) => void ipcRenderer.on('prueba', () => cb()),
  mostrarPantalla: (visible) => ipcRenderer.send('mostrar-pantalla', visible)
}

contextBridge.exposeInMainWorld('airtracksVideo', api)
