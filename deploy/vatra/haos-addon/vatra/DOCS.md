# Vatra

Vatra runs next to your Home Assistant and talks to it through the Supervisor, so there is no
token to create.

1. Start the add-on and open its log: it prints a six-digit **setup code** while the hub has no
   owner.
2. Open the Vatra app on your phone (or `http://<home-assistant-host>:3737`) and claim the hub
   with that code.
3. Your Home Assistant devices appear in Vatra. Phones, watches and the desktop app pair from
   Vatra → Devices.

The hub's data (users, rooms, paired devices, its encryption key) lives in the add-on's storage
and is part of your Home Assistant backups.

---

## Română

Vatra rulează lângă Home Assistant și vorbește cu el prin Supervisor, deci nu trebuie creat
niciun token.

1. Pornește add-on-ul și deschide-i jurnalul: cât timp hubul nu are proprietar, afișează un
   **cod de configurare** din șase cifre.
2. Deschide aplicația Vatra pe telefon (sau `http://<gazda-home-assistant>:3737`) și revendică
   hubul cu acel cod.
3. Dispozitivele din Home Assistant apar în Vatra. Telefoanele, ceasurile și aplicația desktop se
   asociază din Vatra → Dispozitive.

Datele hubului (utilizatori, camere, dispozitive asociate, cheia de criptare) stau în spațiul
add-on-ului și intră în backup-urile Home Assistant.
