
# **PRD: Proyecto de Automatización de Creación de Videos con Sincronización de Audio e Imágenes**

## **Visión Global del Proyecto**

Este proyecto tiene como objetivo **automatizar la creación de videos sincronizados con audio e imágenes**. El sistema debe ser capaz de tomar un archivo de audio, un guion de texto y una serie de imágenes, y generar un video en el cual las imágenes estén perfectamente sincronizadas con las frases del guion y con el audio. Las imágenes estarán acompañadas de animaciones de zoom, y el sistema debe asegurarse de que no haya **huecos vacíos** entre las imágenes, manteniendo una fluidez constante a lo largo del video.

El proyecto está diseñado para ser ejecutado **desde la línea de comandos**. Los usuarios deben ser capaces de proporcionar los archivos necesarios (audio, guion, imágenes), y el sistema se encargará de generar automáticamente el video con la sincronización correcta.

---

## **Objetivos del Proyecto**

1. **Sincronización Precisa**:
   - Las imágenes deben estar sincronizadas con cada frase del audio, sin dejar espacios vacíos.
   - Cada imagen debe comenzar con la frase correspondiente del guion y continuar hasta el inicio de la siguiente frase.

2. **Automatización Completa**:
   - El sistema debe ser **automático**, sin necesidad de intervención manual una vez que los archivos estén preparados.
   - Al ejecutar el proyecto, se debe generar un video en 1920x1080 con las imágenes y el audio sincronizados.

3. **Sin Fondos Negros**:
   - Las imágenes deben ocupar toda la pantalla sin dejar espacio negro, incluso si las proporciones de la imagen no son 16:9.
   - Usaremos el formato "cover" para asegurarnos de que todas las imágenes cubran la pantalla.

4. **Generación de Video con Animaciones de Zoom**:
   - Cada imagen debe tener una animación de **zoom** (o similar) aplicada para evitar que las imágenes se vean estáticas.

5. **Soporte de Archivos**:
   - El sistema recibirá tres tipos de archivos:
     - **Audio**: Con la grabación de la persona que narra el guion.
     - **Guion**: En formato `.txt`, con frases separadas por `|`.
     - **Imágenes**: Las imágenes a utilizar, con sus respectivos nombres que coincidan con las frases.

6. **Entrada y Salida**:
   - Entrada: Los usuarios proporcionarán los archivos en una estructura de carpetas bien definida.
   - Salida: El sistema generará un archivo de video en formato 1920x1080.

---

## **No Objetivos del Proyecto**

1. **Edición Manual de Remotion**:
   - El sistema **no** debe requerir intervención en el código de Remotion una vez configurado.
   - Remotion se usará **como plantilla**, donde los datos serán pasados automáticamente a la plantilla desde la línea de comandos.

2. **Reconocimiento de Voz Complejo**:
   - No se requiere un sistema de reconocimiento de voz que analice o interprete el contenido de los audios más allá de lo necesario para la transcripción.
   - El sistema **no debe corregir el guion ni el audio**; solo debe sincronizar las imágenes con lo que se escucha.

3. **Soporte para Audio Complejo**:
   - El sistema está optimizado para **audio claro y sin ruido externo**. No se procesarán audios con ruido de fondo o de varias personas hablando.

4. **Soporte para Fuentes de Imágenes Complejas**:
   - El sistema no hará un análisis complejo de las imágenes para elegir la más adecuada; se basa en los nombres de archivo y el guion.

---

## **Arquitectura del Sistema**

### **Flujo de Trabajo General**

1. **Estructura de Archivos**:
   - Los archivos se organizan en tres carpetas principales:
     - **`/guion`**: Contendrá un archivo `.txt` con el guion estructurado.
     - **`/audio`**: Contendrá el archivo de audio con la grabación de la persona que lee el guion.
     - **`/imágenes`**: Contendrá todas las imágenes a utilizar en el video.
   - **`/output`**: Carpeta donde se generará el video final.

2. **Proceso de Transcripción de Audio**:
   - Usaremos **Vosk** o **DeepSpeech** (dependiendo de la opción preferida) para transcribir el audio y obtener las marcas de tiempo de cada frase del guion.
   - La transcripción y los tiempos obtenidos se utilizarán para sincronizar el audio con las imágenes.

3. **Procesamiento del Guion**:
   - El guion se leerá desde el archivo `.txt`, separando las frases por `|`. Esto nos proporcionará las frases correspondientes a cada imagen.
   - **spaCy** o un sistema simple de palabras clave será usado para asociar las frases con las imágenes correspondientes.

4. **Generación del Video con Remotion**:
   - **Remotion** se utilizará como plantilla para la creación del video. El sistema generará un archivo JSON con la información de cada imagen, su tiempo de aparición, y la animación de zoom.
   - Las imágenes se ajustarán a la pantalla con `objectFit: 'cover'` para asegurarse de que no haya fondos negros visibles.
   - Se usará un archivo JSON como entrada para Remotion para que se generen los videos de manera automática.

5. **Generación del Archivo JSON**:
   - El archivo JSON será generado con la siguiente estructura:
     ```json
     {
       "frames": [
         {
           "image": "imagen1.jpg",
           "startTime": 0,
           "endTime": 5
         },
         {
           "image": "imagen2.jpg",
           "startTime": 5,
           "endTime": 10
         }
       ]
     }
     ```
   - Este archivo JSON será usado por Remotion para generar el video con las imágenes sincronizadas.

6. **Generación del Video Final**:
   - Al ejecutar el sistema, el archivo JSON será leído por Remotion y se generará el video en 1920x1080 con las imágenes, animaciones y sincronización perfecta con el audio.

---

## **Tecnologías Utilizadas**

- **Vosk/DeepSpeech**: Para la transcripción de audio y la obtención de las marcas de tiempo de cada frase.
- **spaCy**: Para el análisis semántico del guion y la asignación de imágenes.
- **Remotion**: Para generar el video con las imágenes, sincronizarlas con el audio y aplicar las animaciones de zoom.
- **Node.js + fs**: Para la automatización del flujo y la creación del archivo JSON con la información de las imágenes y sus tiempos.
- **ffmpeg**: Para cualquier procesamiento adicional de audio (si es necesario).

---

## **Límites del Sistema**

1. **Audio Claro y Estable**:
   - El sistema está diseñado para trabajar con **audio claro** y sin **ruido externo**. No se procesarán audios con ruido o múltiples voces.

2. **Sin Reconocimiento de Voz Avanzado**:
   - El sistema no tiene la capacidad de reconocer diferentes hablantes o corregir el audio de manera compleja. Solo se utiliza para obtener la transcripción de frases y marcas de tiempo.

3. **Formato de Imágenes**:
   - Las imágenes deben estar en formatos **JPG** o **PNG**. El sistema asume que todas las imágenes se ajustarán a la resolución de 1920x1080 mediante `cover`.

4. **Sin Intervención Manual en Remotion**:
   - No se requiere intervención manual en **Remotion** una vez que se haya configurado el sistema. El proceso de generación del video será completamente automático.

---

## **Conclusión**

Este **PRD.md** detalla los objetivos, no objetivos, arquitectura y flujo del sistema para automatizar la creación de videos sincronizados con audio e imágenes. La integración de tecnologías como **Vosk**, **spaCy**, y **Remotion** permite automatizar cada paso del proceso, desde la transcripción del audio hasta la creación final del video.

Este documento proporciona una visión clara para los desarrolladores y el orquestador del sistema, asegurando que todos entiendan la visión del proyecto, las tecnologías utilizadas, y cómo se conectan las piezas del sistema para producir un video de manera automática y sincronizada.

---

# **Descargar el PRD.md**

Este archivo está listo para ser descargado y utilizado como base para el desarrollo del proyecto.

[Descargar PRD.md](sandbox:/mnt/data/PRD_Proyecto_Automatic_Generation.md)
