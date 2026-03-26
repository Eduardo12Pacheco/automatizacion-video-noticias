# **Tasks.md - Roadmap de Implementación para la Automatización de Creación de Videos con Sincronización de Audio e Imágenes**

Este documento detalla las tareas secuenciales y pasos necesarios para completar el proyecto de **automatización de creación de videos sincronizados con audio e imágenes**. Cada paso debe ejecutarse de forma ordenada para asegurar que el flujo de trabajo sea eficiente y libre de errores.

---

### **Tasks.md - Roadmap de Implementación**

**Estado actual**: 14/14 tareas completadas. Bloqueadas: ninguna.

## **Fase 1: Preparación del Proyecto**

### 1.1 **Configurar el Entorno de Trabajo**

- [x] **Tarea 1.1**: Inicializar proyecto con **Node.js** y configurar entorno de desarrollo.
- [x] **Tarea 1.2**: Instalar dependencias básicas como **Remotion**, **Vosk**, **DeepSpeech** y **spaCy**.
- [x] **Tarea 1.3**: Crear estructura de carpetas:
  - **`/guion`**
  - **`/audio`**
  - **`/imágenes`**
  - **`/output`**

---

### 1.2 **Crear la Estructura de Carpetas**

- [x] **Tarea 1.4**: Crear las carpetas en el sistema de archivos.
  - Crear carpetas:
    - **`/guion`** para el guion del proyecto.
    - **`/audio`** para el archivo de audio.
    - **`/imágenes`** para las imágenes a usar.
    - **`/output`** para los resultados generados.

  ```bash
  mkdir /proyecto
  cd /proyecto
  mkdir guion audio imagenes output
  ```

---

## **Fase 2: Transcripción de Audio**

### 2.1 **Usar Vosk para la Transcripción de Audio**

- [x] **Tarea 2.1**: Configurar Vosk para la transcripción de audio.
  - Descargar e instalar el modelo de voz.
  - Procesar el archivo de audio para obtener la transcripción y las marcas de tiempo.

  **Código de ejemplo para transcripción con Vosk**:

  ```python
  import wave
  from vosk import Model, KaldiRecognizer

  model = Model("model")  # Cargar el modelo preentrenado
  recognizer = KaldiRecognizer(model, 16000)

  with wave.open("audio.wav", "rb") as wf:
      while True:
          data = wf.readframes(4000)
          if len(data) == 0:
              break
          if recognizer.AcceptWaveform(data):
              result = recognizer.Result()
              print(result)  # Salida de transcripción con marcas de tiempo
  ```

### 2.2 **Obtener Marcas de Tiempo de las Frases**

- [x] **Tarea 2.2**: Extraer las marcas de tiempo de cada frase en el audio y asignarlas a las frases del guion.
  - Asegurarse de que cada frase esté asociada con el tiempo exacto en que se pronuncia.

---

## **Fase 3: Procesamiento del Guion**

### 3.1 **Leer y Procesar el Guion**

- [x] **Tarea 3.1**: Crear un script en Python o Node.js para procesar el archivo `.txt` del guion.
  - **Estructura del guion**: El guion debe estar estructurado con `|` para separar cada frase.
  - Usar **spaCy** o un sistema simple para dividir el guion en frases y asignar imágenes a cada frase según el contenido.

  **Código para procesar el guion**:

  ```python
  import spacy

  # Cargar el modelo de spaCy en español
  nlp = spacy.load("es_core_news_sm")

  # Leer el guion
  with open('guion.txt', 'r') as file:
      guion = file.read()

  # Dividir el guion por frases
  frases = guion.split("|")

  # Análisis semántico con spaCy para detectar entidades clave
  for frase in frases:
      doc = nlp(frase)
      for ent in doc.ents:
          print(ent.text, ent.label_)  # Ejemplo: "Selección Colombia" ORG
  ```

### 3.2 **Asignar Imágenes a las Frases**

- [x] **Tarea 3.2**: Usar las entidades extraídas del guion para asociar imágenes con las frases. Si no se encuentra una coincidencia clara, asignar una imagen aleatoria.

---

## **Fase 4: Creación del Video con Remotion**

### 4.1 **Configurar Remotion para la Creación del Video**

- [x] **Tarea 4.1**: Usar **Remotion** para generar el video basado en el archivo JSON.
  - Preparar una plantilla de Remotion que reciba imágenes y audio, y las combine con animaciones de zoom.

  **Plantilla básica de Remotion**:

  ```javascript
  import { Composition, Img, Audio } from "remotion";
  import fs from "fs";

  // Leer el archivo JSON con las marcas de tiempo de las imágenes
  const times = JSON.parse(fs.readFileSync("times.json", "utf8"));

  const Video = ({ audio, image, startTime, endTime }) => (
    <>
      <Audio src={audio} />
      <Img
        src={image}
        style={{
          animation: `zoomIn ${endTime - startTime}s`, // Animación de zoom
          position: "absolute",
          left: 0,
          top: 0,
          width: "100%",
          height: "100%",
        }}
        key={`image-${startTime}`}
      />
    </>
  );

  export const RemotionComposition = ({ audioFile, images }) => (
    <>
      {times.map((time, index) => (
        <Composition
          key={index}
          id={`video-part-${index}`}
          component={Video}
          durationInFrames={times[index].endTime - times[index].startTime}
          fps={30}
          width={1920}
          height={1080}
          defaultProps={{
            audio: audioFile,
            image: images[index],
            startTime: times[index].startTime,
            endTime: times[index].endTime,
          }}
        />
      ))}
    </>
  );
  ```

### 4.2 **Ajuste de Imágenes con "Cover"**

- [x] **Tarea 4.2**: Configurar las imágenes para que se ajusten como **cover** (cubran toda la pantalla sin distorsionar) utilizando la propiedad `objectFit: 'cover'` en Remotion.

---

## **Fase 5: Generación Final del Video**

### 5.1 **Generar el Video con Remotion**

- [x] **Tarea 5.1**: Ejecutar el script de Remotion para generar el video. Asegurarse de que las imágenes y el audio estén correctamente sincronizados.
  - Asegurarse de que el video final tenga la resolución de **1920x1080**.

### 5.2 **Exportación del Video**

- [x] **Tarea 5.2**: Exportar el video generado en formato **MP4** o cualquier otro formato necesario.

---

## **Fase 6: Finalización y Pruebas**

### 6.1 **Verificar la Sincronización**

- [x] **Tarea 6.1**: Realizar pruebas para verificar que las imágenes estén sincronizadas correctamente con el audio y que no haya huecos vacíos entre las imágenes.

### 6.2 **Ajustes y Mejoras**

- [x] **Tarea 6.2**: Realizar ajustes si se encuentran problemas de sincronización, o si las imágenes no se ajustan bien al tamaño de pantalla.

---

## **Conclusión**

Este archivo **Tasks.md** detalla las tareas y pasos necesarios para automatizar la creación de videos sincronizados con audio e imágenes. La implementación debe seguir estos pasos de manera secuencial para asegurar que el sistema funcione correctamente y de manera eficiente.
