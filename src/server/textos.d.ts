// archivos .txt incluidos como texto al compilar (esbuild, loader "text")
declare module '*.txt' {
  const texto: string
  export default texto
}
