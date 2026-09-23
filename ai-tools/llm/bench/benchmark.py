import time
import requests
import statistics

API_URL = "http://localhost:8080/v1/chat/completions"
#API_URL = "http://localhost:11434/v1/chat/completions"

# Prompt de stress test (long = meilleur benchmark)
PROMPT = """
Tu es un modèle de langage. Génère un texte technique de 500 mots sur l’architecture
des modèles Mixture-of-Experts modernes, en détaillant les mécanismes de routing,
les experts, la sparsité, et les avantages en inference.
"""

N_RUNS = 5  # nombre de mesures pour moyenne

def run_benchmark():
    latencies = []
    tok_speeds = []

    for i in range(N_RUNS):
        print(f"\n--- Run {i+1}/{N_RUNS} ---")

        payload = {
            "model": "qwen3.6-35b-a3b",
            "messages": [
                {"role": "user", "content": PROMPT}
            ],
            "max_tokens": 512,
            "temperature": 0.2
        }

        #payload = {
        #    "model": "qwen3.6:35b",
        #    "messages": [
        #        {"role": "user", "content": PROMPT}
        #    ],
        #    "max_tokens": 512,
        #    "temperature": 0.2
        #}

        start = time.time()
        response = requests.post(API_URL, json=payload, timeout=600)
        end = time.time()

        if response.status_code != 200:
            print("Erreur API:", response.text)
            continue

        data = response.json()
        output = data["choices"][0]["message"]["content"]

        # Comptage tokens générés
        generated_tokens = data.get("usage", {}).get("completion_tokens", None)
        if generated_tokens is None:
            # fallback si usage non renvoyé
            generated_tokens = len(output.split())

        total_time = end - start
        tok_s = generated_tokens / total_time

        latencies.append(total_time)
        tok_speeds.append(tok_s)

        print(f"Temps total : {total_time:.2f} s")
        print(f"Tokens générés : {generated_tokens}")
        print(f"Débit : {tok_s:.2f} tok/s")

    print("\n===== Résultats finaux =====")
    print(f"Latence moyenne : {statistics.mean(latencies):.2f} s")
    print(f"Débit moyen : {statistics.mean(tok_speeds):.2f} tok/s")
    print(f"Débit max : {max(tok_speeds):.2f} tok/s")
    print(f"Débit min : {min(tok_speeds):.2f} tok/s")


if __name__ == "__main__":
    run_benchmark()