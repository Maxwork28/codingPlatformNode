'use strict';

/**
 * Ubiquitous input/output idioms per language. Almost every solution (human or AI) contains them,
 * so they carry no signal about where code came from; like starter code they are removed before
 * scoring. Matching is on normalized tokens (identifiers → ID), so any variable names match.
 * Keep entries short and truly generic: anything algorithmic must NOT be listed here.
 */
const IDIOMS = {
    python: [
        'n = int(input())',
        'n = int(input().strip())',
        'a = list(map(int, input().split()))',
        'a = list(map(int, input().strip().split()))',
        'a, b = map(int, input().split())',
        'a = [int(x) for x in input().split()]',
        'data = sys.stdin.read().split()',
        'input = sys.stdin.readline',
        'n = int(data[0])',
        'a = list(map(int, data[1:n + 1]))',
        'a = [int(x) for x in data[1:n + 1]]',
        'print(x)',
        'if __name__ == "__main__":\n    main()',
    ],
    javascript: [
        "const lines = require('fs').readFileSync(0, 'utf8').trim().split('\\n');",
        "const data = require('fs').readFileSync(0, 'utf8').trim().split('\\n');",
        "const input = require('fs').readFileSync('/dev/stdin', 'utf8');",
        "const data = require('fs').readFileSync(0, 'utf8');",
        'const n = parseInt(lines[0]);',
        'const n = Number(lines[0]);',
        'const nums = lines[1].split(" ").map(Number);',
        'const nums = lines[1].trim().split(" ").map(Number);',
        'console.log(x);',
    ],
    cpp: [
        'ios::sync_with_stdio(false); cin.tie(nullptr);',
        'ios_base::sync_with_stdio(false); cin.tie(NULL);',
        'int main() {',
        'int n; cin >> n;',
        'long long n; cin >> n;',
        'vector<int> a(n); for (auto &x : a) cin >> x;',
        'vector<long long> a(n); for (auto &x : a) cin >> x;',
        'vector<int> a(n); for (int i = 0; i < n; i++) cin >> a[i];',
        'for (int i = 0; i < n; i++) cin >> a[i];',
        'cout << x << endl;',
        'cout << x << "\\n";',
        'return 0;',
    ],
    c: [
        'int main() {',
        'int main(void) {',
        'int n; scanf("%d", &n);',
        'for (int i = 0; i < n; i++) scanf("%d", &a[i]);',
        'printf("%d\\n", x);',
        'printf("%lld\\n", x);',
        'return 0;',
    ],
    java: [
        'public class Main {',
        'public static void main(String[] args) {',
        'public static void main(String[] args) throws IOException {',
        'Scanner sc = new Scanner(System.in);',
        'BufferedReader br = new BufferedReader(new InputStreamReader(System.in));',
        'int n = sc.nextInt();',
        'int n = Integer.parseInt(br.readLine().trim());',
        'int[] a = new int[n];',
        'for (int i = 0; i < n; i++) a[i] = sc.nextInt();',
        'for (int i = 0; i < n; i++) { a[i] = sc.nextInt(); }',
        'System.out.println(x);',
    ],
    go: [
        'func main() {',
        'reader := bufio.NewReader(os.Stdin)',
        'var n int\nfmt.Scan(&n)',
        'fmt.Scan(&n)',
        'a := make([]int, n)',
        'for i := 0; i < n; i++ { fmt.Scan(&a[i]) }',
        'fmt.Println(x)',
    ],
    ruby: ['n = gets.to_i', 'a = gets.split.map(&:to_i)', 'n = gets.chomp.to_i', 'puts x'],
    php: [
        '$n = intval(trim(fgets(STDIN)));',
        "$a = array_map('intval', explode(' ', trim(fgets(STDIN))));",
        'echo $x . PHP_EOL;',
        'echo $x . "\\n";',
    ],
};

module.exports = { IDIOMS };
