Restrictions:
Users can only delete lists and (user_words) they own.
Users can only SEE dictionary words that are verified/system; their own meanings live in user_words (own-only).
Users CANNOT write the dictionary (`words`) at all — clients read verified rows only; only the edge function writes verified entries.
ALL is virtual (= the user's user_words). The ALL container can't be wiped wholesale, but individual words CAN be deleted from it.
User can see only their own data, dates and confidence etc.
Editing a word OVERRIDES its meaning in place (custom_translation) — no duplicate row.
Deleting a word removes it from ALL and every sub-list (cascade); re-adding later starts at confidence 0.
Removing a word from a sub-list only un-tags it (it stays in the vocabulary / ALL).

TRANSLATE
On a cache hit do not make a call to provider
Successful translate of single word adds all translations to dictionary with verified true and made by system on a cache miss
Paragraph translation saves every new word and returns meaning(s) correctly mapped to each word. Check for different counts of meaning, 0-2. Paragraph is also run through MT for a display check, this does not persist.
Successfully does nothing on a null return from provider

Query
All queries of user information e.g. getting list information is correct