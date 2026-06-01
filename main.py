import os
import sys
from typing import Annotated
from dotenv import load_dotenv
from line.llm_agent import LlmAgent, LlmConfig, loopback_tool, end_call
from line.voice_agent_app import VoiceAgentApp
from supabase import create_client, Client

# Nastavenie kódovania konzoly na UTF-8 pre Windows, aby logovanie slovenských názvov s diakritikou nespadlo na charmap encoding error
if sys.platform.startswith("win"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

load_dotenv()

# =====================================================================
# INICIALIZÁCIA SUPABASE
# =====================================================================
supabase_url = os.getenv("SUPABASE_URL")
supabase_key = os.getenv("SUPABASE_SERVICE_KEY")

supabase: Client = None
if supabase_url and supabase_key:
    try:
        supabase = create_client(supabase_url, supabase_key)
        print("[SUCCESS] Supabase klient bol úspešne inicializovaný.")
    except Exception as e:
        print(f"[ERROR] Zlyhala inicializácia Supabase klienta: {e}")
else:
    print("[WARNING] Supabase URL alebo kľúč chýbajú v .env. Použije sa iba lokálny zoznam ulíc.")

# =====================================================================
# SYSTEM PROMPT PRE PIZZERIU
# =====================================================================
SYSTEM_PROMPT = """
Si milá a rýchla hlasová asistentka pizzérie "Pizzeria Sicillia". Prijímaš telefonické objednávky na doručenie. Rozprávaš vždy v ženskom rode.
Slovo "pizza" vyslovuj ako "pica". Nikdy nepýtaj meno ani telefónne číslo.

[Menu]
1. Prosciutto Cotto (8.20 €), 2. Pizza Funghi (7.70 €), 3. Margherita (7.50 €), 4. Tonno (8.40 €), 5. Pizza Formaggi (9.00 €), 6. Pizza 4 Stagioni (9.40 €), 7. Hawai (8.80 €), 8. Gazdovská (9.80 €)

[Flow]
1. Pozdrav: "Pizzeria Sicillia, dobrý deň, akú pizzu vám dnes pripravíme?"
2. Výber jedla: Počkaj na voľbu. Keď zákazník dokončí výber jedál, ponúkni Colu za 2.20 €.
3. Adresa doručenia: Vypýtaj si ulicu a číslo domu. 
   DÔLEŽITÉ: Akonáhle zákazník povie názov ulice, OKAMŽITE zavolaj nástroj 'over_adresu_v_databaze' s presným názvom ulice.
4. Finálne zhrnutie: Keď máš jedlo aj adresu, zhrň celú objednávku JEDNOU vetou ako oznam a následne použi nástroj 'end_call'. Ceny vyslovuj slovami.
"""

# =====================================================================
# NÁSTROJ NA OVEROVANIE ADRIES
# =====================================================================
@loopback_tool
async def over_adresu_v_databaze(
    ctx, 
    nazov_ulice: Annotated[str, "Názov ulice, ktorú zákazník nadiktoval, napr. Obchodná alebo Francisciho"]
) -> str:
    """Tento nástroj overí ulicu v Supabase tabuľke 'streets'."""
    
    print(f"\n[LOG] Kód práve overuje ulicu v databáze: {nazov_ulice}")
    
    # Príprava textu na porovnanie
    ulica_vstup = nazov_ulice.strip().lower()
    
    # 1. Pokus o dopyt do Supabase, ak je k dispozícii
    if supabase:
        try:
            # Query do Supabase tabuľky streets
            response = supabase.table("streets").select("*").ilike("name", f"%{nazov_ulice}%").execute()
            data = response.data
            
            if data:
                presny_nazov = data[0]["name"]
                print(f"[LOG] Ulica úspešne nájdená v Supabase: {presny_nazov}")
                return f"Ulica {presny_nazov} bola úspešne overená v databáze zóny streets. Doručenie sem je možné."
        except Exception as e:
            print(f"[ERROR] Chyba pri dopytovaní Supabase databázy: {e}")
            
    # 2. Lokálny fallback zoznam
    povolene_ulice = ["obchodná", "francisciho", "hlavná", "mýtna", "rozvoj"]
    
    # Skontrolujeme, či sa vstup nachádza v našom lokálnom zozname
    for ulica in povolene_ulice:
        if ulica in ulica_vstup:
            print(f"[LOG] Ulica úspešne nájdená v lokálnom fallbacku: {ulica.capitalize()}")
            return f"Ulica {ulica.capitalize()} bola úspešne overená v zóne streets. Doručenie sem je možné."
            
    print(f"[LOG] Ulica '{nazov_ulice}' nebola nájdená ani v databáze ani v lokálnom fallbacku.")
    return f"Ulicu s názvom '{nazov_ulice}' som v našej databáze streets nenašiel. Opýtaj sa na inú adresu."

# =====================================================================
# INICIALIZÁCIA AGENTA
# =====================================================================
async def get_agent(env, call_request):
    gemini_key = os.getenv("GEMINI_API_KEY")
    if not gemini_key:
        print("[WARNING] GEMINI_API_KEY chýba v .env! Uistite sa, že ho pridáte.")
        
    return LlmAgent(
        model="gemini/gemini-3.5-flash",
        api_key=gemini_key,
        tools=[over_adresu_v_databaze, end_call],
        config=LlmConfig(
            system_prompt=SYSTEM_PROMPT,
        ),
    )

app = VoiceAgentApp(get_agent=get_agent)

if __name__ == "__main__":
    app.run()
