Restrictions:
Users can only delete lists and words they own.
Users can only see words that they own or created by system
Users can only create verified words
User cant delete their own ALL list
User can see only their data, dates and confidence etc
Users can edit words in their dictionary but this creates their own copy and reassigns the links.

TRANSLATE
On a cache hit do not make a call to provider
Successful translate of single word adds all translations to dictionary with verified true and made by system on a cache miss
Paragraph translation saves every new word and returns meaning(s) correctly mapped to each word. Check for different counts of meaning, 0-2. Paragraph is also run through MT for a display check, this does not persist.
Successfully does nothing on a null return from provider

Query
All queries of user information e.g. getting list information is correct