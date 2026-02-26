import os, requests, anthropic

api_key   = os.environ['ANTHROPIC_API_KEY']
gh_token  = os.environ['GITHUB_TOKEN']
pr_number = os.environ['PR_NUMBER']
repo      = os.environ['REPO']

# Read the conflict file content
with open('conflict_files.txt', 'r') as f:
    conflict_content = f.read()

# Ask Claude to suggest a resolution
client = anthropic.Anthropic(api_key=api_key)
message = client.messages.create(
    model='claude-opus-4-6',
    max_tokens=2048,
    messages=[{
        'role': 'user',
        'content': f'''These files have merge conflicts (shown by <<<<<<, =======, >>>>>>>).
        For each conflict, suggest the best way to resolve it and explain why.

        CONFLICTED FILES:
        {conflict_content[:6000]}'''
    }]
)

suggestion = message.content[0].text

# Post suggestion as PR comment
url = f'https://api.github.com/repos/{repo}/issues/{pr_number}/comments'
headers = {'Authorization': f'token {gh_token}'}
body = f'## ⚔️ Merge Conflict Detected\n\n🤖 **Claude Suggests:**\n\n{suggestion}'
requests.post(url, headers=headers, json={'body': body})
print('Conflict resolution posted!')
