# Carga el programa del congreso (un módulo por entrada). Uso: python3 scripts/cargar-programa.py .admin-pin
# OJO: borra antes todas las ponencias existentes y sus preguntas.
import json, sys, subprocess
BASE = "https://preguntas-congreso.davidtroncosop.workers.dev/api/admin"
PIN = open(sys.argv[1]).read().strip()
def call(method, path, body=None):
    cmd = ["curl", "-sf", "-X", method, BASE + path, "-H", "x-admin-pin: " + PIN, "-H", "content-type: application/json"]
    if body is not None: cmd += ["--data-binary", json.dumps(body)]
    return json.loads(subprocess.run(cmd, check=True, capture_output=True, text=True).stdout)
for t in call("GET", "/state")["talks"]:
    call("DELETE", f"/talks/{t['id']}")
call("POST", "/settings", {"eventName": "Desafiando las Fronteras en Salud y Rehabilitación"})
talks = [
 ("22 oct · 09:00 · Innovación desde la Nutrición", "Ferran Adrià · Adrián González · Viviana Sandoval · Carolina Añazco"),
 ("22 oct · 11:30 · I+D: del laboratorio a la sociedad", "Claudio Tapia · Guillermo Droppelmann · David Andrade · Alejandro Neira"),
 ("22 oct · 14:00 · Innovación desde la Fonoaudiología", "Anthony Marcotti · Carla Contreras · Isabel Gallardo"),
 ("22 oct · 16:00 · Innovación Social", "Rodrigo López · Andrés Villagrán · Agustín Ibáñez"),
 ("23 oct · 09:00 · Premio Wolf en Medicina 2026: El viaje del sabor", "Dr. Charles S. Zuker · Dr. Tomás Pérez-Acle"),
 ("23 oct · 10:20 · Transdisciplina en Innovación", "Matías Zañartu · Christoph Guger"),
 ("23 oct · 12:00 · Innovación para el manejo del dolor", "Jens Reinhold · Claudio Carvajal · Carolina Rivera · Nicolás Jiménez"),
 ("23 oct · 15:00 · Desafío de Innovación", "Daniela García · Daniel Martínez · Rodrigo Cubillos"),
 ("23 oct · 17:00 · Innovación en Neurorehabilitación", "David Alexander Reyes · Jordan Squair"),
]
for title, speaker in talks:
    call("POST", "/talks", {"title": title, "speaker": speaker})
s = call("GET", "/state")
print(s["eventName"])
for t in s["talks"]: print(t["position"], t["title"], "|", t["speaker"])
