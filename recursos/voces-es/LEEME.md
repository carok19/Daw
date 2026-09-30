# Voces en español que trae el programa

Las voces que avisan el salto ("Coro… 3, 4"): las secciones y los números en
español de los recursos gratuitos **"Click and Guide Samples"** de
[Secuencias.com](https://secuencias.com).

Se armaron con `armarVocesDeFabrica` (`src/server/voces.ts`): el pack se
importa como cualquier otro (solo la parte en español) y cada voz queda como
WAV mono de 48 kHz recortado a lo hablado. `indice.json` dice qué nombre es
cada archivo y dónde empieza y termina lo hablado.
