# Preguntas para congreso

App para recibir preguntas del público después de cada ponencia. Corre en Cloudflare:
**Workers** sirve las páginas, un **Durable Object** con SQLite guarda los datos y empuja
los cambios en tiempo real por WebSocket, y **MiniMax** (modelo `MiniMax-M2`) filtra el contenido inapropiado.

- `/`: página del público (móvil). Muestra la ponencia abierta, sirve para enviar preguntas y votarlas.
- `/admin`: panel del moderador, protegido con PIN.

## Flujo

1. En `/admin` añade las ponencias del programa.
2. Al terminar una ponencia pulsa **Abrir preguntas**. Solo puede haber una abierta y abrir otra cierra la anterior.
3. Las preguntas llegan al instante a **Pendientes** y MiniMax las revisa en segundo plano (unos segundos):
   - Mientras tanto verás 🤖 revisando…; después, 🤖 OK.
   - Si son inapropiadas, pasan solas a **Ocultas** con el motivo. Si fue un error puedes restaurarlas.
   - Las preguntas críticas o incómodas se consideran válidas: solo se bloquean insultos, odio, spam, etc.
4. **Publicar**: la pregunta aparece para el público, que puede votarla. La lista se ordena por votos.
5. **Marcar respondida** cuando el ponente la conteste, y **Cerrar preguntas** al terminar.

## Desarrollo local

```sh
npm install
npm run dev        # http://localhost:8787  (PIN local: 1234, en .dev.vars)
```

`.dev.vars` lleva `MINIMAX_API_KEY` para la moderación. Para desactivarla añade `AI_MODERATION=off`.

## Despliegue

```sh
npx wrangler login
npx wrangler secret put ADMIN_PIN         # elige un PIN robusto
npx wrangler secret put MINIMAX_API_KEY   # tu key de MiniMax
npm run deploy
```

Te dará una URL `https://preguntas-congreso.<tu-cuenta>.workers.dev`. Genera un QR con ella para
proyectarlo en la sala. También puedes asignarle un dominio propio desde el panel de Cloudflare.

## Notas

- Límites: 300 caracteres por pregunta y una pregunta cada 15 s por dispositivo.
- Un voto por dispositivo y pregunta. Se identifica con un id aleatorio en el navegador, así que no es infalible, pero basta para un congreso.
- Si MiniMax falla o tarda más de 25 s, la pregunta sigue en Pendientes con la etiqueta 🤖 sin revisar.
- Si apruebas una pregunta antes de que termine la revisión, tu decisión manda: la IA no la oculta.
- La key de MiniMax sale de `api.minimax.io`, la plataforma internacional.
